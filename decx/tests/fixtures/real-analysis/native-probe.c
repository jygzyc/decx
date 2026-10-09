/* DECX-owned real executable fixture. Apache-2.0. */
#include <stdio.h>
#include <stdlib.h>
#ifdef _WIN32
#define EXPORT __declspec(dllexport) __declspec(noinline)
#else
#define EXPORT __attribute__((visibility("default"), noinline))
#endif

EXPORT int decx_score(int input) {
    if (input == 37) return 1337;
    return input - 11;
}

EXPORT int decx_mix(int input) {
    return input * 7 + 13;
}

int main(int argc, char **argv) {
    int input = argc > 1 ? atoi(argv[1]) : 37;
    printf("DECX_REAL_NATIVE score=%d mix=%d\n", decx_score(input), decx_mix(input));
    return 0;
}
