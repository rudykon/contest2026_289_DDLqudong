#include "watch_tools.h"
#include <cassert>
#include <cstdio>
int main() {
    watch::Stopwatch s;
    s.toggle(1000); assert(s.elapsed(2500) == 1500);
    s.toggle(3000); assert(s.elapsed(900000) == 2000);
    s.toggle(900000); assert(s.elapsed(900123) == 2123);
    s.reset(); assert(!s.running && s.elapsed(999999) == 0);
    watch::Countdown c;
    c.adjust(-60); assert(c.selected == 10000);
    c.toggle(1000); assert(c.left(6000) == 5000);
    c.adjust(60); assert(c.selected == 10000);
    c.toggle(6000); assert(c.left(900000) == 5000);
    c.toggle(900000); assert(!c.expire(904999));
    assert(c.expire(905000)); assert(!c.expire(906000));
    assert(c.left(906000) == 0); c.toggle(907000);
    assert(c.left(908000) == 9000);
    c.reset(); c.adjust(999999); assert(c.selected == 5940000);
    watch::Calendar d; d.year=2028; d.month=1; d.day=31;
    d.adjust(1,1); assert(d.day == 29);
    d.adjust(0,1); assert(d.day == 28);
    d.month=12; d.adjust(1,1); assert(d.month==1);
    d.hour=0; d.adjust(3,-1); assert(d.hour==23);
    d.minute=59; d.adjust(4,1); assert(d.minute==0);
    d.year=2037; d.adjust(0,1); assert(d.year==2025);
    assert(watch::days_in_month(2100,2)==28);
    assert(watch::days_in_month(2000,2)==29);
    puts("watch tools: duration/pause/resume/expiry/bounds/calendar passed");
}
