#pragma once
// Minimal check macros for the host-compiled native tests (tests/native/CMakeLists.txt).
// Each test is its own executable; main() returns the failure count.
#include <cstdio>

static int g_failures = 0;

#define CHECK(cond)                                                      \
    do {                                                                 \
        if (!(cond)) {                                                   \
            std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
            ++g_failures;                                                \
        }                                                                \
    } while (0)

#define CHECK_EQ(a, b)                                                                   \
    do {                                                                                 \
        const auto va_ = (a);                                                            \
        const auto vb_ = (b);                                                            \
        if (!(va_ == vb_)) {                                                             \
            std::printf("FAIL %s:%d: %s == %s (%lld vs %lld)\n", __FILE__, __LINE__, #a, \
                        #b, static_cast<long long>(va_), static_cast<long long>(vb_));   \
            ++g_failures;                                                                \
        }                                                                                \
    } while (0)

inline int native_test_result(const char* name) {
    if (g_failures == 0) std::printf("PASS %s\n", name);
    else std::printf("%s: %d failure(s)\n", name, g_failures);
    return g_failures == 0 ? 0 : 1;
}
