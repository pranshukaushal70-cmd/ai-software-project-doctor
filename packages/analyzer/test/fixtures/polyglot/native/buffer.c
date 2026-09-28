#include <stdio.h>
#include <stdlib.h>
#include "buffer.h"

static int unused_helper(int x) {
    return x * 2;
}

static int clamp(int v, int lo, int hi) {
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
}

int buffer_fill(char *buf, int len, int mode) {
    int written = 0;
    for (int i = 0; i < len; i++) {
        switch (mode) {
        case 0:
            buf[i] = 'a';
            break;
        case 1:
            buf[i] = (i % 2) ? 'b' : 'c';
            break;
        default:
            return -1;
            written = -2;
        }
        if (buf[i] == 'b' && written > 0) {
            written++;
        }
        written = clamp(written, 0, len);
    }
    return written;
}
