cmake_minimum_required(VERSION 3.21)
project(gpuix_js LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(HERMES_SOURCE "${CMAKE_CURRENT_LIST_DIR}/../.deps/hermes" CACHE PATH "Hermes checkout")
set(LIBUV_SOURCE "${CMAKE_CURRENT_LIST_DIR}/../.deps/hermes-libuv" CACHE PATH "libuv checkout")
set(HERMES_ENABLE_TEST_SUITE OFF CACHE BOOL "" FORCE)
# Upstream's NAPI CMake targets reference the CLI even with tests disabled.
# Configure the targets but build only gpuix_js; no Android CLI is packaged.
set(HERMES_ENABLE_TOOLS ON CACHE BOOL "" FORCE)
set(HERMES_ENABLE_DEBUGGER OFF CACHE BOOL "" FORCE)
set(HERMES_ENABLE_NAPI ON CACHE BOOL "" FORCE)
set(HERMES_ENABLE_INTL OFF CACHE BOOL "" FORCE)
set(HERMES_UNICODE_LITE ON CACHE BOOL "" FORCE)
set(HERMESVM_ALLOW_JIT 0 CACHE STRING "" FORCE)
set(HERMESVM_INTERNAL_JAVASCRIPT_NATIVE OFF CACHE BOOL "" FORCE)
set(HERMES_ENABLE_CORE_EXTENSIONS OFF CACHE BOOL "" FORCE)
# The standalone VM needs no fbjni or React Native runtime.
set(HERMES_IS_ANDROID OFF CACHE BOOL "" FORCE)
set(HERMES_IS_MOBILE_BUILD ON CACHE BOOL "" FORCE)
set(LIBUV_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(LIBUV_BUILD_BENCH OFF CACHE BOOL "" FORCE)
set(LIBUV_BUILD_SHARED OFF CACHE BOOL "" FORCE)

add_subdirectory("${HERMES_SOURCE}" hermes EXCLUDE_FROM_ALL)
# The upstream combined archive also contains the optional JSI facade, whose
# Android implementation requires fbjni. Node-API talks directly to the VM;
# exclude only that unused facade without modifying Hermes source.
foreach(link_property LINK_LIBRARIES INTERFACE_LINK_LIBRARIES)
  get_target_property(vm_components hermesvm_a ${link_property})
  list(REMOVE_ITEM vm_components hermesapi_obj)
  set_property(TARGET hermesvm_a PROPERTY ${link_property} "${vm_components}")
endforeach()
# VM's object target uses the facade only to inherit public header paths.
add_library(gpuix_hermes_api_headers INTERFACE)
get_target_property(hermes_api_headers hermesapi_obj INTERFACE_INCLUDE_DIRECTORIES)
target_include_directories(gpuix_hermes_api_headers INTERFACE ${hermes_api_headers})
target_link_libraries(gpuix_hermes_api_headers INTERFACE hermesPublic_obj jsi)
foreach(link_property LINK_LIBRARIES INTERFACE_LINK_LIBRARIES)
  get_target_property(vm_components hermesVMRuntime_obj ${link_property})
  list(TRANSFORM vm_components REPLACE "^hermesapi_obj$" "gpuix_hermes_api_headers")
  set_property(TARGET hermesVMRuntime_obj PROPERTY ${link_property} "${vm_components}")
endforeach()
add_subdirectory("${LIBUV_SOURCE}" libuv EXCLUDE_FROM_ALL)
add_library(gpuix_js SHARED runner.cpp)
target_include_directories(gpuix_js PRIVATE "${HERMES_SOURCE}/API")
target_compile_definitions(gpuix_js PRIVATE NAPI_VERSION=10)
# Runtime.h is an internal embedding interface; its layout must match the VM.
get_directory_property(HERMES_VM_DEFINITIONS DIRECTORY "${HERMES_SOURCE}" COMPILE_DEFINITIONS)
target_compile_definitions(gpuix_js PRIVATE ${HERMES_VM_DEFINITIONS})
target_compile_options(gpuix_js PRIVATE -fno-rtti -fno-exceptions)
# Link NAPI as objects so every ABI entrypoint is exported for napi-rs.
target_link_libraries(gpuix_js PRIVATE hermesNapi_obj hermesvm_a uv_a log)
target_link_options(gpuix_js PRIVATE -Wl,-z,max-page-size=16384)
