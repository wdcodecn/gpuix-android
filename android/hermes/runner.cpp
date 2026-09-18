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
#include <mutex>
#include <string>
#include <unordered_map>

namespace {
constexpr char kTag[] = "GPUIX-JS";
struct Task { void *data; void (*callback)(void *); };
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
  std::unordered_map<uint32_t, Timer *> timers;
  std::unordered_map<void *, Work *> work;
  std::atomic<bool> stop{false};
  uint32_t next_id{1};
};
std::mutex active_mutex;
Runner *active = nullptr;

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
void log_exception(napi_env env) {
  bool pending = false;
  napi_is_exception_pending(env, &pending);
  if (!pending) return;
  napi_value error, stack;
  napi_get_and_clear_last_exception(env, &error);
  if (napi_get_named_property(env, error, "stack", &stack) == napi_ok)
    __android_log_print(ANDROID_LOG_ERROR, kTag, "%s", text(env, stack).c_str());
  else
    __android_log_print(ANDROID_LOG_ERROR, kTag, "%s", text(env, error).c_str());
}
void checkpoint(Runner *runner) {
  log_exception(runner->env);
  if (runner->runtime->drainJobs() == hermes::vm::ExecutionStatus::EXCEPTION)
    log_exception(runner->env);
  runner->runtime->clearKeptObjects();
}
void dispatch(uv_async_t *handle) {
  auto *runner = static_cast<Runner *>(handle->data);
  if (runner->stop.load()) { uv_stop(&runner->loop); return; }
  std::deque<Task> tasks;
  { std::lock_guard<std::mutex> lock(runner->tasks_mutex); tasks.swap(runner->tasks); }
  for (auto &task : tasks) {
    napi_handle_scope scope;
    napi_open_handle_scope(runner->env, &scope);
    task.callback(task.data);
    checkpoint(runner);
    napi_close_handle_scope(runner->env, scope);
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
void close_timer(Timer *timer) {
  timer->owner->timers.erase(timer->id);
  napi_delete_reference(timer->owner->env, timer->callback);
  uv_timer_stop(&timer->handle);
  uv_close(reinterpret_cast<uv_handle_t *>(&timer->handle), [](uv_handle_t *handle) { delete static_cast<Timer *>(handle->data); });
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
    {"__gpuixSchedule", schedule}, {"__gpuixCancel", cancel_timer}, {"__gpuixNow", now}, {"__gpuixLog", log}
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
globalThis.setTimeout = (fn,ms,...args)=>__gpuixSchedule(()=>fn(...args),Number(ms)||0,false);
globalThis.setInterval = (fn,ms,...args)=>__gpuixSchedule(()=>fn(...args),Number(ms)||0,true);
globalThis.clearTimeout = globalThis.clearInterval = __gpuixCancel;
globalThis.setImmediate = (fn,...args)=>setTimeout(fn,0,...args);
globalThis.clearImmediate = __gpuixCancel;
globalThis.queueMicrotask = globalThis.queueMicrotask || (fn=>Promise.resolve().then(fn));
globalThis.requestAnimationFrame = fn=>setTimeout(()=>fn(performance.now()),16);
globalThis.cancelAnimationFrame = clearTimeout;
)JS";
}

extern "C" int gpuix_js_run(const uint8_t *bundle, size_t length, gpuix_register_module register_module) {
  Runner runner;
  if (uv_loop_init(&runner.loop) != 0) return 1;
  uv_async_init(&runner.loop, &runner.async, dispatch);
  runner.async.data = &runner;
  hermes_napi_host host{};
  host.data = &runner; host.post_task = post_task; host.post_work = post_work; host.cancel_work = cancel_work; host.uv_loop = &runner.loop;
  host.fatal_exception = [](void *, napi_env env, napi_value error) { __android_log_print(ANDROID_LOG_ERROR, kTag, "%s", text(env, error).c_str()); };
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
      __android_log_print(ANDROID_LOG_INFO, kTag, "Hermes Node-API registered GPUIX, loading %zu bytes", length);
      status = hermes_run_script(runner.env, bundle, length, nullptr, nullptr, "gpuix-app.js", nullptr, &result);
    }
  }
  checkpoint(&runner);
  napi_close_handle_scope(runner.env, scope);
  if (status == napi_ok) uv_run(&runner.loop, UV_RUN_DEFAULT);
  { std::lock_guard<std::mutex> lock(active_mutex); active = nullptr; }
  while (!runner.timers.empty()) close_timer(runner.timers.begin()->second);
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
  if (active) { active->stop.store(true); uv_async_send(&active->async); }
}
