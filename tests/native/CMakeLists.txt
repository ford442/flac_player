# Host-compiled native tests for the engine headers (no emsdk):
#   npm run test:native     (scripts/test-native.sh: configure, build, ctest)
#
# Covers src/sdl/play_ring.h, play_fill.h, pcm_scrub.h and the scalar path of
# dsp_chain.h. The *_golden.cpp tests need wasm SIMD and stay on em++
# (npm run test:dsp-golden). compile_commands.json lands in .build/native for
# clangd (see .clangd).
cmake_minimum_required(VERSION 3.16)
project(flac_player_native_tests CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE RelWithDebInfo)
endif()

enable_testing()

file(GLOB NATIVE_TESTS CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/*_test.cpp)
foreach(src ${NATIVE_TESTS})
  get_filename_component(name ${src} NAME_WE)
  add_executable(${name} ${src})
  # The em++ release build does not enable these; the engine headers must stay clean.
  target_compile_options(${name} PRIVATE -Wall -Wextra -Werror)
  add_test(NAME ${name} COMMAND ${name})
endforeach()
