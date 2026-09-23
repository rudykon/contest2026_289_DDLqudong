#pragma once
#include <cstdint>

namespace watch {
// Durations use monotonic time: setting the wall clock cannot change a timer.
struct Stopwatch {
    bool running = false;
    uint64_t accumulated = 0, started = 0;
    uint64_t elapsed(uint64_t now) const {
        return accumulated + (running ? now - started : 0);
    }
    void toggle(uint64_t now) {
        if (running) accumulated = elapsed(now);
        else started = now;
        running = !running;
    }
    void reset() { running = false; accumulated = 0; }
};
struct Countdown {
    uint64_t selected = 60000, remaining = 60000, started = 0;
    bool running = false;
    uint64_t left(uint64_t now) const {
        const uint64_t used = running ? now - started : 0;
        return used >= remaining ? 0 : remaining - used;
    }
    void toggle(uint64_t now) {
        if (running) remaining = left(now);
        else { if (!remaining) remaining = selected; started = now; }
        running = !running;
    }
    bool expire(uint64_t now) {
        if (!running || left(now)) return false;
        running = false; remaining = 0; return true;
    }
    void reset() { running = false; remaining = selected; }
    void adjust(int seconds) {
        if (running) return;
        int64_t value = static_cast<int64_t>(selected) + seconds * 1000LL;
        selected = value < 10000 ? 10000 : value > 5940000 ? 5940000 : value;
        remaining = selected;
    }
};
inline int days_in_month(int year, int month) {
    const int days[] = {31,28,31,30,31,30,31,31,30,31,30,31};
    return month == 2 && year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
        ? 29 : days[month - 1];
}
struct Calendar {
    int year = 2026, month = 1, day = 1, hour = 12, minute = 0;
    void adjust(int field, int step) {
        int *values[] = {&year, &month, &day, &hour, &minute};
        const int minimum[] = {2025,1,1,0,0};
        // This board's prebuilt runtime uses signed 32-bit time_t.
        const int maximum[] = {2037,12,days_in_month(year,month),23,59};
        int &v = *values[field];
        v += step;
        if (v < minimum[field]) v = maximum[field];
        if (v > maximum[field]) v = minimum[field];
        const int last = days_in_month(year, month);
        if (day > last) day = last;
    }
};
}
