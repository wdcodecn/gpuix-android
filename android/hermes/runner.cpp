// Runtime setup follows facebook/hermes tools/napi-runner (MIT).
// Scheduling, timers and worker execution use libuv, not a second JS framework.
#include "gpuix_js.h"
#include "hermes/Public/RuntimeConfig.h"
#include "hermes/VM/Runtime.h"
#include "napi/hermes_napi.h"
#include <android/log.h>
#include <uv.h>
#include <atomic>
#include <cstring>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

namespace {
constexpr char kTag[] = "GPUIX-JS";
// Little-endian Hermes bytecode file header magic (BytecodeFileFormat.h).
constexpr uint64_t kHermesBytecodeMagic = 0x1F1903C103BC1FC6ULL;

struct Task { void *data; void (*callback)(void *); };
struct HotEval { std::vector<uint8_t> bytes; std::string url; bool reset_timers; };
struct Runner;
struct Timer { uv_timer_t handle{}; Runner *owner; napi_ref callback; uint32_t id; bool repeat; };
struct Work { uv_work_t request{}; Runner *owner; void *data; void (*execute)(void *); void (*complete)(void *, napi_status); };
struct Runner {
  uv_loop_t loop{};
  uv_async_t async{};
  napi_env env{};
  hermes::vm::Runtime *runtime{};
  std::mutex tasks_mutex;
  std::deque<Task> tasks;
  std::deque<HotEval> evals;
  // Keeps persistent .hbc buffers alive for the lifetime of the Hermes VM.
  std::vector<std::unique_ptr<std::vector<uint8_t>>> retained_bundles;
  std::unordered_map<uint32_t, Timer *> timers;
  std::unordered_map<uint32_t, napi_ref> raf_callbacks;
  std::vector<uint32_t> raf_order;
  std::unordered_map<void *, Work *> work;
  std::atomic<bool> stop{false};
  std::atomic<bool> gc_pending{false};
  std::atomic<bool> vsync_pending{false};
  std::atomic<double> vsync_timestamp_ms{0.0};
  std::atomic<bool> has_raf{false};
  uint32_t next_id{1};
  uint32_t next_raf_id{1};
};

std::mutex active_mutex;
Runner *active = nullptr;
std::atomic<gpuix_request_vsync_fn> vsync_requester{nullptr};
std::atomic<gpuix_fatal_error_fn> fatal_handler{nullptr};
std::atomic<gpuix_hot_eval_result_fn> hot_eval_handler{nullptr};

bool is_hermes_bytecode(const uint8_t *data, size_t length) {
  if (!data || length < sizeof(kHermesBytecodeMagic)) return false;
  uint64_t magic = 0;
  std::memcpy(&magic, data, sizeof(magic));
  return magic == kHermesBytecodeMagic;
}

std::string text(napi_env env, napi_value value) {
  napi_value str;
  if (napi_coerce_to_string(env, value, &str) != napi_ok) return "<unprintable>";
  size_t size = 0;
  napi_get_value_string_utf8(env, str, nullptr, 0, &size);
  std::string result(size + 1, '\0');
  napi_get_value_string_utf8(env, str, result.data(), result.size(), &size);
  result.resize(size);
  return result;
}

void report_fatal(const std::string &message) {
  __android_log_print(ANDROID_LOG_ERROR, kTag, "%s", message.c_str());
  if (auto fn = fatal_handler.load(std::memory_order_acquire)) {
    fn(message.c_str());
  }
}

void log_exception(napi_env env) {
  bool pending = false;
  napi_is_exception_pending(env, &pending);
  if (!pending) return;
  napi_value error, stack;
  napi_get_and_clear_last_exception(env, &error);
  if (napi_get_named_property(env, error, "stack", &stack) == napi_ok)
    report_fatal(text(env, stack));
  else
    report_fatal(text(env, error));
}

bool capture_exception_text(napi_env env, std::string &out) {
  bool pending = false;
  napi_is_exception_pending(env, &pending);
  if (!pending) return false;
  napi_value error, stack;
  napi_get_and_clear_last_exception(env, &error);
  if (napi_get_named_property(env, error, "stack", &stack) == napi_ok)
    out = text(env, stack);
  else
    out = text(env, error);
  report_fatal(out);
  return true;
}

void checkpoint(Runner *runner) {
  log_exception(runner->env);
  if (runner->runtime->drainJobs() == hermes::vm::ExecutionStatus::EXCEPTION)
    log_exception(runner->env);
  runner->runtime->clearKeptObjects();
}

void close_timer(Timer *timer) {
  timer->owner->timers.erase(timer->id);
  napi_delete_reference(timer->owner->env, timer->callback);
  uv_timer_stop(&timer->handle);
  uv_close(reinterpret_cast<uv_handle_t *>(&timer->handle), [](uv_handle_t *handle) { delete static_cast<Timer *>(handle->data); });
}

void clear_timers_and_raf(Runner *runner) {
  for (auto &[id, ref] : runner->raf_callbacks) {
    napi_delete_reference(runner->env, ref);
  }
  runner->raf_callbacks.clear();
  runner->raf_order.clear();
  runner->has_raf.store(false, std::memory_order_release);
  while (!runner->timers.empty()) {
    close_timer(runner->timers.begin()->second);
  }
}

void drain_raf(Runner *runner, double timestamp_ms) {
  if (runner->raf_order.empty()) {
    runner->has_raf.store(false, std::memory_order_release);
    return;
  }
  std::vector<uint32_t> batch;
  batch.swap(runner->raf_order);
  runner->has_raf.store(false, std::memory_order_release);

  napi_handle_scope scope;
  napi_open_handle_scope(runner->env, &scope);
  napi_value global, ts;
  napi_get_global(runner->env, &global);
  napi_create_double(runner->env, timestamp_ms, &ts);

  for (uint32_t id : batch) {
    auto it = runner->raf_callbacks.find(id);
    if (it == runner->raf_callbacks.end()) continue;
    napi_ref ref = it->second;
    runner->raf_callbacks.erase(it);
    napi_value fn, result;
    if (napi_get_reference_value(runner->env, ref, &fn) == napi_ok) {
      napi_call_function(runner->env, global, fn, 1, &ts, &result);
      checkpoint(runner);
    }
    napi_delete_reference(runner->env, ref);
  }
  napi_close_handle_scope(runner->env, scope);
}

void dispatch(uv_async_t *handle) {
  auto *runner = static_cast<Runner *>(handle->data);
  if (runner->stop.load(std::memory_order_acquire)) { uv_stop(&runner->loop); return; }

  std::deque<Task> tasks;
  std::deque<HotEval> evals;
  {
    std::lock_guard<std::mutex> lock(runner->tasks_mutex);
    tasks.swap(runner->tasks);
    evals.swap(runner->evals);
  }
  for (auto &task : tasks) {
    napi_handle_scope scope;
    napi_open_handle_scope(runner->env, &scope);
    task.callback(task.data);
    checkpoint(runner);
    napi_close_handle_scope(runner->env, scope);
  }

  if (runner->vsync_pending.exchange(false, std::memory_order_acq_rel)) {
    drain_raf(runner, runner->vsync_timestamp_ms.load(std::memory_order_acquire));
  }

  for (auto &item : evals) {
    napi_handle_scope scope;
    napi_open_handle_scope(runner->env, &scope);
    napi_value global, hook, result;
    napi_get_global(runner->env, &global);
    if (napi_get_named_property(runner->env, global, "__gpuixHotCleanup", &hook) == napi_ok) {
      napi_valuetype hook_type = napi_undefined;
      if (napi_typeof(runner->env, hook, &hook_type) == napi_ok && hook_type == napi_function) {
        napi_call_function(runner->env, global, hook, 0, nullptr, &result);
        checkpoint(runner);
      }
    }
    if (item.reset_timers) {
      clear_timers_and_raf(runner);
    }

    napi_status st = napi_generic_failure;
    if (is_hermes_bytecode(item.bytes.data(), item.bytes.size())) {
      auto owned = std::make_unique<std::vector<uint8_t>>(std::move(item.bytes));
      const uint8_t *bc_data = owned->data();
      const size_t bc_size = owned->size();
      runner->retained_bundles.push_back(std::move(owned));
      hermes_bytecode_flags bc_flags{};
      bc_flags.struct_size = sizeof(hermes_bytecode_flags);
      bc_flags.persistent = true;
      __android_log_print(ANDROID_LOG_INFO, kTag, "Hot-evaluating Hermes HBC %s (%zu bytes)", item.url.c_str(), bc_size);
      st = hermes_run_bytecode(
          runner->env,
          bc_data,
          bc_size,
          nullptr,
          nullptr,
          item.url.c_str(),
          &bc_flags,
          &result);
    } else {
      if (item.bytes.empty() || item.bytes.back() != 0) {
        item.bytes.push_back(0);
      }
      __android_log_print(ANDROID_LOG_INFO, kTag, "Hot-evaluating JS %s (%zu bytes)", item.url.c_str(), item.bytes.size());
      st = hermes_run_script(
          runner->env,
          item.bytes.data(),
          item.bytes.size(),
          nullptr,
          nullptr,
          item.url.c_str(),
          nullptr,
          &result);
    }

    std::string err_msg;
    bool has_ex = capture_exception_text(runner->env, err_msg);
    if (!has_ex && st == napi_ok) {
      if (runner->runtime->drainJobs() == hermes::vm::ExecutionStatus::EXCEPTION) {
        has_ex = capture_exception_text(runner->env, err_msg);
      }
      runner->runtime->clearKeptObjects();
    }
    bool ok = (st == napi_ok) && !has_ex;
    if (!ok && err_msg.empty()) {
      err_msg = "hermes eval failed (status=" + std::to_string(static_cast<int>(st)) + ")";
      report_fatal(err_msg);
    }
    if (auto fn = hot_eval_handler.load(std::memory_order_acquire)) {
      fn(ok, item.url.c_str(), ok ? nullptr : err_msg.c_str());
    }
    napi_close_handle_scope(runner->env, scope);
  }

  if (runner->gc_pending.exchange(false, std::memory_order_acq_rel)) {
    runner->runtime->collect("low_memory");
  }
}

void post_task(void *data, void *task, void (*callback)(void *)) {
  auto *runner = static_cast<Runner *>(data);
  { std::lock_guard<std::mutex> lock(runner->tasks_mutex); runner->tasks.push_back({task, callback}); }
  uv_async_send(&runner->async);
}

void post_work(void *data, void *work_data, void (*execute)(void *), void (*complete)(void *, napi_status)) {
  auto *runner = static_cast<Runner *>(data);
  auto *work = new Work{};
  work->owner = runner; work->data = work_data; work->execute = execute; work->complete = complete;
  work->request.data = work;
  runner->work[work_data] = work;
  uv_queue_work(&runner->loop, &work->request,
    [](uv_work_t *req) { auto *w = static_cast<Work *>(req->data); w->execute(w->data); },
    [](uv_work_t *req, int status) {
      auto *w = static_cast<Work *>(req->data);
      auto *r = w->owner;
      r->work.erase(w->data);
      napi_handle_scope scope;
      napi_open_handle_scope(r->env, &scope);
      w->complete(w->data, status == UV_ECANCELED ? napi_cancelled : napi_ok);
      checkpoint(r);
      napi_close_handle_scope(r->env, scope);
      delete w;
    });
}

bool cancel_work(void *data, void *work_data) {
  auto *runner = static_cast<Runner *>(data);
  auto it = runner->work.find(work_data);
  return it != runner->work.end() && uv_cancel(reinterpret_cast<uv_req_t *>(&it->second->request)) == 0;
}

napi_value schedule(napi_env env, napi_callback_info info) {
  size_t argc = 3; napi_value args[3]; void *data;
  napi_get_cb_info(env, info, &argc, args, nullptr, &data);
  auto *runner = static_cast<Runner *>(data);
  napi_valuetype type;
  if (!argc || napi_typeof(env, args[0], &type) != napi_ok || type != napi_function) {
    napi_throw_type_error(env, nullptr, "Timer callback must be a function"); return nullptr;
  }
  double ms = 0; bool repeat = false;
  if (argc > 1) napi_get_value_double(env, args[1], &ms);
  if (argc > 2) napi_get_value_bool(env, args[2], &repeat);
  auto *timer = new Timer{};
  timer->owner = runner; timer->id = runner->next_id++; timer->repeat = repeat;
  napi_create_reference(env, args[0], 1, &timer->callback);
  uv_timer_init(&runner->loop, &timer->handle);
  timer->handle.data = timer;
  runner->timers[timer->id] = timer;
  auto delay = static_cast<uint64_t>(ms > 0 ? ms : 0);
  uv_timer_start(&timer->handle, [](uv_timer_t *handle) {
    auto *t = static_cast<Timer *>(handle->data);
    auto *r = t->owner; auto id = t->id; bool repeat = t->repeat;
    napi_handle_scope scope;
    napi_open_handle_scope(r->env, &scope);
    napi_value fn, global, result;
    napi_get_reference_value(r->env, t->callback, &fn);
    napi_get_global(r->env, &global);
    napi_call_function(r->env, global, fn, 0, nullptr, &result);
    checkpoint(r);
    napi_close_handle_scope(r->env, scope);
    auto still = r->timers.find(id);
    if (!repeat && still != r->timers.end()) close_timer(still->second);
  }, delay, repeat ? (delay ? delay : 1) : 0);
  napi_value result; napi_create_uint32(env, timer->id, &result); return result;
}

napi_value cancel_timer(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value args[1]; void *data; uint32_t id = 0;
  napi_get_cb_info(env, info, &argc, args, nullptr, &data);
  if (argc) napi_get_value_uint32(env, args[0], &id);
  auto *runner = static_cast<Runner *>(data);
  auto it = runner->timers.find(id);
  if (it != runner->timers.end()) close_timer(it->second);
  return nullptr;
}

napi_value request_raf(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value args[1]; void *data;
  napi_get_cb_info(env, info, &argc, args, nullptr, &data);
  auto *runner = static_cast<Runner *>(data);
  napi_valuetype type;
  if (!argc || napi_typeof(env, args[0], &type) != napi_ok || type != napi_function) {
    napi_throw_type_error(env, nullptr, "requestAnimationFrame callback must be a function");
    return nullptr;
  }
  uint32_t id = runner->next_raf_id++;
  napi_ref ref = nullptr;
  napi_create_reference(env, args[0], 1, &ref);
  runner->raf_callbacks[id] = ref;
  runner->raf_order.push_back(id);
  bool was_empty = !runner->has_raf.exchange(true, std::memory_order_acq_rel);
  if (auto req = vsync_requester.load(std::memory_order_acquire)) {
    if (was_empty) {
      req();
    }
  } else {
    // Fallback when running without an attached hardware VSync callback.
    napi_value global, fn, delay, fallback_result;
    napi_get_global(env, &global);
    if (napi_get_named_property(env, global, "__gpuixFallbackRaf", &fn) == napi_ok) {
      napi_create_uint32(env, id, &delay);
      napi_call_function(env, global, fn, 1, &delay, &fallback_result);
    }
  }
  napi_value result;
  napi_create_uint32(env, id, &result);
  return result;
}

napi_value cancel_raf(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value args[1]; void *data; uint32_t id = 0;
  napi_get_cb_info(env, info, &argc, args, nullptr, &data);
  if (argc) napi_get_value_uint32(env, args[0], &id);
  auto *runner = static_cast<Runner *>(data);
  auto it = runner->raf_callbacks.find(id);
  if (it != runner->raf_callbacks.end()) {
    napi_delete_reference(env, it->second);
    runner->raf_callbacks.erase(it);
    if (runner->raf_callbacks.empty()) {
      runner->has_raf.store(false, std::memory_order_release);
    }
  }
  return nullptr;
}

napi_value consume_raf_one(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value args[1]; void *data; uint32_t id = 0;
  napi_get_cb_info(env, info, &argc, args, nullptr, &data);
  if (argc) napi_get_value_uint32(env, args[0], &id);
  auto *runner = static_cast<Runner *>(data);
  auto it = runner->raf_callbacks.find(id);
  if (it == runner->raf_callbacks.end()) return nullptr;
  napi_ref ref = it->second;
  runner->raf_callbacks.erase(it);
  if (runner->raf_callbacks.empty()) {
    runner->has_raf.store(false, std::memory_order_release);
  }
  napi_value fn, global, ts, result;
  if (napi_get_reference_value(env, ref, &fn) == napi_ok) {
    napi_get_global(env, &global);
    napi_create_double(env, static_cast<double>(uv_hrtime()) / 1000000.0, &ts);
    napi_call_function(env, global, fn, 1, &ts, &result);
  }
  napi_delete_reference(env, ref);
  return nullptr;
}

napi_value collect_gc(napi_env env, napi_callback_info info) {
  void *data = nullptr;
  napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &data);
  auto *runner = static_cast<Runner *>(data);
  if (runner && runner->runtime) {
    runner->runtime->collect("idle");
  }
  return nullptr;
}

napi_value now(napi_env env, napi_callback_info) {
  napi_value value; napi_create_double(env, static_cast<double>(uv_hrtime()) / 1000000.0, &value); return value;
}

napi_value log(napi_env env, napi_callback_info info) {
  size_t argc = 16; napi_value args[16];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  std::string message;
  for (size_t i = 0; i < argc; ++i) { if (i) message += ' '; message += text(env, args[i]); }
  __android_log_print(ANDROID_LOG_INFO, kTag, "%s", message.c_str()); return nullptr;
}

void install(Runner *runner) {
  napi_value global; napi_get_global(runner->env, &global);
  struct Binding { const char *name; napi_callback callback; } bindings[] = {
    {"__gpuixSchedule", schedule},
    {"__gpuixCancel", cancel_timer},
    {"__gpuixNow", now},
    {"__gpuixLog", log},
    {"__gpuixCollectGarbage", collect_gc},
    {"__gpuixRafRequest", request_raf},
    {"__gpuixRafCancel", cancel_raf},
    {"__gpuixRafConsume", consume_raf_one},
  };
  for (const auto &binding : bindings) {
    napi_value fn;
    napi_create_function(runner->env, binding.name, NAPI_AUTO_LENGTH, binding.callback, runner, &fn);
    napi_set_named_property(runner->env, global, binding.name, fn);
  }
}

constexpr char bootstrap[] = R"JS(
globalThis.global = globalThis;
globalThis.console = {log:__gpuixLog,info:__gpuixLog,warn:__gpuixLog,error:__gpuixLog,debug:__gpuixLog,trace:__gpuixLog};
globalThis.performance = {now:__gpuixNow};
globalThis.gc = __gpuixCollectGarbage;
globalThis.setTimeout = (fn,ms,...args)=>__gpuixSchedule(()=>fn(...args),Number(ms)||0,false);
globalThis.setInterval = (fn,ms,...args)=>__gpuixSchedule(()=>fn(...args),Number(ms)||0,true);
globalThis.clearTimeout = globalThis.clearInterval = __gpuixCancel;
globalThis.setImmediate = (fn,...args)=>setTimeout(fn,0,...args);
globalThis.clearImmediate = __gpuixCancel;
globalThis.queueMicrotask = globalThis.queueMicrotask || (fn=>Promise.resolve().then(fn));
globalThis.__gpuixFallbackRaf = id => setTimeout(() => __gpuixRafConsume(id), 16);
globalThis.requestAnimationFrame = fn => __gpuixRafRequest(fn);
globalThis.cancelAnimationFrame = id => __gpuixRafCancel(id);
)JS";
}

extern "C" int gpuix_js_run(const uint8_t *bundle, size_t length, gpuix_register_module register_module) {
  Runner runner;
  if (uv_loop_init(&runner.loop) != 0) return 1;
  uv_async_init(&runner.loop, &runner.async, dispatch);
  runner.async.data = &runner;
  hermes_napi_host host{};
  host.data = &runner; host.post_task = post_task; host.post_work = post_work; host.cancel_work = cancel_work; host.uv_loop = &runner.loop;
  host.fatal_exception = [](void *, napi_env env, napi_value error) { report_fatal(text(env, error)); };
  auto config = hermes::vm::RuntimeConfig::Builder().withMicrotaskQueue(true).build();
  auto runtime = hermes::vm::Runtime::create(config);
  runner.runtime = &*runtime;
  runner.env = hermes_napi_create_env(runner.runtime, &host);
  { std::lock_guard<std::mutex> lock(active_mutex); active = &runner; }
  napi_handle_scope scope;
  napi_open_handle_scope(runner.env, &scope);
  install(&runner);
  napi_value result, global, exports;
  auto status = hermes_run_script(runner.env, reinterpret_cast<const uint8_t *>(bootstrap), sizeof(bootstrap), nullptr, nullptr, "gpuix-host.js", nullptr, &result);
  if (status == napi_ok) {
    napi_create_object(runner.env, &exports);
    exports = static_cast<napi_value>(register_module(runner.env, exports));
    bool pending = false;
    napi_is_exception_pending(runner.env, &pending);
    if (!exports || pending) {
      status = napi_pending_exception;
    } else {
      napi_get_global(runner.env, &global);
      napi_set_named_property(runner.env, global, "__gpuixNative", exports);
      if (is_hermes_bytecode(bundle, length)) {
        hermes_bytecode_flags bc_flags{};
        bc_flags.struct_size = sizeof(hermes_bytecode_flags);
        bc_flags.persistent = true;
        __android_log_print(ANDROID_LOG_INFO, kTag, "Hermes Node-API registered GPUIX, running HBC %zu bytes", length);
        status = hermes_run_bytecode(runner.env, bundle, length, nullptr, nullptr, "gpuix-app.hbc", &bc_flags, &result);
      } else {
        std::vector<uint8_t> js_buf;
        const uint8_t *js_ptr = bundle;
        size_t js_len = length;
        if (length > 0 && bundle[length - 1] != 0) {
          js_buf.assign(bundle, bundle + length);
          js_buf.push_back(0);
          js_ptr = js_buf.data();
          js_len = js_buf.size();
        }
        __android_log_print(ANDROID_LOG_INFO, kTag, "Hermes Node-API registered GPUIX, compiling JS %zu bytes", length);
        status = hermes_run_script(runner.env, js_ptr, js_len, nullptr, nullptr, "gpuix-app.js", nullptr, &result);
      }
    }
  }
  checkpoint(&runner);
  napi_close_handle_scope(runner.env, scope);
  if (status == napi_ok) uv_run(&runner.loop, UV_RUN_DEFAULT);
  { std::lock_guard<std::mutex> lock(active_mutex); active = nullptr; }
  clear_timers_and_raf(&runner);
  uv_unref(reinterpret_cast<uv_handle_t *>(&runner.async));
  for (const auto &[data, work] : runner.work)
    uv_cancel(reinterpret_cast<uv_req_t *>(&work->request));
  while (!runner.work.empty()) uv_run(&runner.loop, UV_RUN_DEFAULT);
  // NAPI finalizers may still use the host, so keep libuv alive through teardown.
  runtime.reset();
  uv_close(reinterpret_cast<uv_handle_t *>(&runner.async), nullptr);
  uv_run(&runner.loop, UV_RUN_DEFAULT);
  uv_loop_close(&runner.loop);
  __android_log_print(ANDROID_LOG_INFO, kTag, "JS worker exited status=%d", status);
  return status == napi_ok ? 0 : 2;
}

extern "C" void gpuix_js_request_stop(void) {
  std::lock_guard<std::mutex> lock(active_mutex);
  if (active) { active->stop.store(true, std::memory_order_release); uv_async_send(&active->async); }
}

extern "C" void gpuix_js_low_memory(void) {
  std::lock_guard<std::mutex> lock(active_mutex);
  if (active) { active->gc_pending.store(true, std::memory_order_release); uv_async_send(&active->async); }
}

extern "C" void gpuix_js_set_vsync_requester(gpuix_request_vsync_fn fn) {
  vsync_requester.store(fn, std::memory_order_release);
}

extern "C" void gpuix_js_set_fatal_handler(gpuix_fatal_error_fn fn) {
  fatal_handler.store(fn, std::memory_order_release);
}

extern "C" void gpuix_js_set_hot_eval_handler(gpuix_hot_eval_result_fn fn) {
  hot_eval_handler.store(fn, std::memory_order_release);
}

extern "C" void gpuix_js_on_vsync(double timestamp_ms) {
  std::lock_guard<std::mutex> lock(active_mutex);
  if (active && active->has_raf.load(std::memory_order_acquire)) {
    active->vsync_timestamp_ms.store(timestamp_ms, std::memory_order_release);
    active->vsync_pending.store(true, std::memory_order_release);
    uv_async_send(&active->async);
  }
}

extern "C" bool gpuix_js_has_raf_callbacks(void) {
  std::lock_guard<std::mutex> lock(active_mutex);
  return active && active->has_raf.load(std::memory_order_acquire);
}

extern "C" bool gpuix_js_eval_bundle(const uint8_t *data, size_t length, const char *source_url, bool reset_timers) {
  if (!data || length == 0) return false;
  std::lock_guard<std::mutex> lock(active_mutex);
  if (!active) return false;
  {
    std::lock_guard<std::mutex> qlock(active->tasks_mutex);
    active->evals.push_back(HotEval{
        std::vector<uint8_t>(data, data + length),
        source_url ? std::string(source_url) : std::string("gpuix-hot.bundle"),
        reset_timers,
    });
  }
  uv_async_send(&active->async);
  return true;
}

extern "C" bool gpuix_js_eval_script(const uint8_t *source, size_t length, const char *source_url) {
  return gpuix_js_eval_bundle(source, length, source_url ? source_url : "gpuix-hot.js", true);
}
