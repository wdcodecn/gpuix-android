#ifndef GPUIX_LIBUV_ANDROID_COMPAT_H
#define GPUIX_LIBUV_ANDROID_COMPAT_H

#if defined(__ANDROID__) && defined(__ANDROID_API__) && __ANDROID_API__ < 28

#include <errno.h>
#include <signal.h>
#include <spawn.h>
#include <stddef.h>
#include <sys/types.h>

/*
 * libuv v1.53.0 sets posix_spawn_works = 0 on Android at process.c and falls
 * back to fork(), but its helper code still statically references posix_spawn*
 * symbols gated behind __INTRODUCED_IN(28) in NDK <spawn.h>. Provide static
 * inline ENOSYS stubs when targeting API < 28 so minSdk=26 links cleanly
 * without patching upstream libuv sources.
 */

static inline int gpuix_compat_posix_spawn(
    pid_t* pid,
    const char* path,
    const posix_spawn_file_actions_t* file_actions,
    const posix_spawnattr_t* attrp,
    char* const argv[],
    char* const envp[]) {
  (void)pid;
  (void)path;
  (void)file_actions;
  (void)attrp;
  (void)argv;
  (void)envp;
  return ENOSYS;
}

static inline int gpuix_compat_posix_spawnattr_init(posix_spawnattr_t* attr) {
  (void)attr;
  return ENOSYS;
}

static inline int gpuix_compat_posix_spawnattr_destroy(posix_spawnattr_t* attr) {
  (void)attr;
  return 0;
}

static inline int gpuix_compat_posix_spawnattr_setflags(
    posix_spawnattr_t* attr,
    short flags) {
  (void)attr;
  (void)flags;
  return ENOSYS;
}

static inline int gpuix_compat_posix_spawnattr_setsigdefault(
    posix_spawnattr_t* attr,
    const sigset_t* sigdefault) {
  (void)attr;
  (void)sigdefault;
  return ENOSYS;
}

static inline int gpuix_compat_posix_spawnattr_setsigmask(
    posix_spawnattr_t* attr,
    const sigset_t* sigmask) {
  (void)attr;
  (void)sigmask;
  return ENOSYS;
}

static inline int gpuix_compat_posix_spawn_file_actions_init(
    posix_spawn_file_actions_t* file_actions) {
  (void)file_actions;
  return ENOSYS;
}

static inline int gpuix_compat_posix_spawn_file_actions_destroy(
    posix_spawn_file_actions_t* file_actions) {
  (void)file_actions;
  return 0;
}

static inline int gpuix_compat_posix_spawn_file_actions_addopen(
    posix_spawn_file_actions_t* file_actions,
    int fd,
    const char* path,
    int oflag,
    mode_t mode) {
  (void)file_actions;
  (void)fd;
  (void)path;
  (void)oflag;
  (void)mode;
  return ENOSYS;
}

static inline int gpuix_compat_posix_spawn_file_actions_addclose(
    posix_spawn_file_actions_t* file_actions,
    int fd) {
  (void)file_actions;
  (void)fd;
  return ENOSYS;
}

static inline int gpuix_compat_posix_spawn_file_actions_adddup2(
    posix_spawn_file_actions_t* file_actions,
    int fd,
    int newfd) {
  (void)file_actions;
  (void)fd;
  (void)newfd;
  return ENOSYS;
}

#define posix_spawn gpuix_compat_posix_spawn
#define posix_spawnattr_init gpuix_compat_posix_spawnattr_init
#define posix_spawnattr_destroy gpuix_compat_posix_spawnattr_destroy
#define posix_spawnattr_setflags gpuix_compat_posix_spawnattr_setflags
#define posix_spawnattr_setsigdefault gpuix_compat_posix_spawnattr_setsigdefault
#define posix_spawnattr_setsigmask gpuix_compat_posix_spawnattr_setsigmask
#define posix_spawn_file_actions_init gpuix_compat_posix_spawn_file_actions_init
#define posix_spawn_file_actions_destroy gpuix_compat_posix_spawn_file_actions_destroy
#define posix_spawn_file_actions_addopen gpuix_compat_posix_spawn_file_actions_addopen
#define posix_spawn_file_actions_addclose gpuix_compat_posix_spawn_file_actions_addclose
#define posix_spawn_file_actions_adddup2 gpuix_compat_posix_spawn_file_actions_adddup2

#endif

#endif
