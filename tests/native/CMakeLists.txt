# Host-compiled native tests for the engine headers (no emsdk):
#   npm run test:native     (scripts/test-native.sh: configure, build, ctest)
#
# Covers src/sdl/play_ring.h, engine_state.h, pcm_scrub.h, the audio_engine.cpp
# exports and the scalar path of dsp_chain.h. The *_golden.cpp tests need wasm
# SIMD and stay on em++ (npm run test:dsp-golden). compile_commands.json lands
# in .build/native for clangd (see .clangd).
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
# The engine itself, under the same warnings (and a compile command for clangd).
add_library(audio_engine_host OBJECT ${CMAKE_CURRENT_SOURCE_DIR}/../../src/sdl/audio_engine.cpp)
target_compile_options(audio_engine_host PRIVATE -Wall -Wextra -Werror)

foreach(src ${NATIVE_TESTS})
  get_filename_component(name ${src} NAME_WE)
  add_executable(${name} ${src})
  # The em++ release build does not enable these; the engine headers must stay clean.
  target_compile_options(${name} PRIVATE -Wall -Wextra -Werror)
  add_test(NAME ${name} COMMAND ${name})
endforeach()
