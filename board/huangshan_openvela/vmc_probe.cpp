// Local development probe. Runs on the LVGL thread; no network endpoint.
// Synthetic taps validate application events, not the physical touch sensor.
#include <lvgl.h>
#include <zlib.h>
#include <cstdio>
#include <cstdlib>
#include <cstdint>
#include <cstring>
#include <unistd.h>
#include <nuttx/sched.h>
#include <nuttx/irq.h>
#include <arch/irq.h>
#include <pthread.h>
#include <atomic>
extern "C" bool vmc_epic_command(const char *);

static lv_indev_t *probe_input;
static lv_point_t probe_point;
static bool probe_pressed;
static bool probe_release_pending;
static bool probe_swiping;
static int swipe_step, swipe_x, swipe_y, swipe_dx, swipe_dy;
static bool perf_enabled, perf_pending, perf_trace;
static uint32_t perf_start, perf_before, refresh_start, refresh_total, refresh_max, refresh_count;
static uint32_t flush_start, flush_ms, flush_pixels, flush_count, layout_ms;
static uint32_t tick_last, tick_gap_max;
static std::atomic<bool> cpu_sampling{false};
static pid_t cpu_target;
static volatile uint32_t xip_bad_address, xip_expected, xip_actual;

// All code and literals in SRAM while changing the active XIP read protocol.
// No erase/program/status-register writes; failed data comparison restores it.
static __attribute__((section(".ramfunc"), noinline)) bool test_xip_mode(unsigned mode, bool full = false, unsigned divider = 0)
{
    volatile uint32_t reference[4096];
    auto cmd = reinterpret_cast<volatile uint32_t *>(0x50042040);
    auto cfg = reinterpret_cast<volatile uint32_t *>(0x50042048);
    auto invalidate = reinterpret_cast<volatile uint32_t *>(0xe000ef5c);
    auto prescaler = reinterpret_cast<volatile uint32_t *>(0x5004200c);
    uint32_t old_divider = *prescaler;
    if (!divider) divider = old_divider;
    uint32_t old_cmd = *cmd, old_cfg = *cfg, irq;
    asm volatile("mrs %0, primask\ncpsid i" : "=r"(irq) :: "memory");
    if (full) {
        // Two streaming passes, one protocol change. Repeated per-block
        // switching can itself perturb the controller's in-flight reads.
        // CRC32 covers every byte; each 64 KiB block has its own checksum.
        uint32_t table[256];
        for (unsigned i = 0; i < 256; ++i) {
            uint32_t crc = i;
            for (unsigned bit = 0; bit < 8; ++bit)
                crc = (crc >> 1) ^ ((crc & 1) ? 0xedb88320u : 0);
            table[i] = crc;
        }
        bool ok = true;
        for (unsigned pass = 0; pass < 2; ++pass) {
            if (pass) {
                asm volatile("dsb sy\nisb sy" ::: "memory");
                *cmd = (old_cmd & ~255u) | (mode == 2 ? 0x3bu : 0x0bu);
                *cfg = (old_cfg & ~(7u << 18)) | (mode << 18);
                *prescaler = divider;
                asm volatile("dsb sy\nisb sy" ::: "memory");
            }
            for (unsigned block = 0; block < 256; ++block) {
                uintptr_t address = 0x12000000u + (block << 16);
                uint32_t crc = 0xffffffffu;
                for (unsigned line = 0; line < 65536; line += 32) {
                    *invalidate = address + line;
                    asm volatile("dsb sy" ::: "memory");
                    auto words = reinterpret_cast<volatile const uint32_t *>(address + line);
                    for (unsigned word = 0; word < 8; ++word) {
                        uint32_t value = words[word];
                        for (unsigned byte = 0; byte < 4; ++byte) {
                            crc = table[(crc ^ value) & 255] ^ (crc >> 8);
                            value >>= 8;
                        }
                    }
                }
                if (!pass) reference[block] = crc;
                else if (crc != reference[block]) {
                    if (ok) { xip_bad_address = address; xip_expected = reference[block]; xip_actual = crc; }
                    ok = false;
                }
            }
        }
        asm volatile("dsb sy" ::: "memory");
        if (!ok) { *cmd = old_cmd; *cfg = old_cfg; *prescaler = old_divider; }
        for (uintptr_t address = 0x12000000u; address < 0x13000000u; address += 32) *invalidate = address;
        asm volatile("dsb sy\nisb sy\nmsr primask, %0" :: "r"(irq) : "memory");
        return ok;
    }
    for (unsigned block = 0; block < 512; ++block) {
        uintptr_t address = 0x12000000u + ((block >> 1) << 16) + ((block & 1) << 12);
        *invalidate = address;
        asm volatile("dsb sy" ::: "memory");
        auto words = reinterpret_cast<volatile const uint32_t *>(address);
        for (unsigned word = 0; word < 8; ++word) reference[block * 8 + word] = words[word];
    }
    asm volatile("dsb sy\nisb sy" ::: "memory");
    *cmd = (old_cmd & ~255u) | (mode == 3 ? 0x6bu : mode == 2 ? 0x3bu : 0x0bu);
    *cfg = (old_cfg & ~(7u << 18)) | (mode << 18);
    asm volatile("dsb sy\nisb sy" ::: "memory");
    bool ok = true;
    for (unsigned block = 0; block < 512; ++block) {
        uintptr_t address = 0x12000000u + ((block >> 1) << 16) + ((block & 1) << 12);
        *invalidate = address;
        asm volatile("dsb sy" ::: "memory");
        auto words = reinterpret_cast<volatile const uint32_t *>(address);
        for (unsigned word = 0; word < 8; ++word)
            if (words[word] != reference[block * 8 + word]) ok = false;
    }
    if (!ok) { *cmd = old_cmd; *cfg = old_cfg; }
    for (unsigned block = 0; block < 512; ++block)
        *invalidate = 0x12000000u + ((block >> 1) << 16) + ((block & 1) << 12);
    asm volatile("dsb sy\nisb sy\nmsr primask, %0" :: "r"(irq) : "memory");
    return ok;
}

extern "C" void vmc_xip_init()
{
    printf("VMC_XIP boot dual=%d fallback=single\n", test_xip_mode(2));
}

static void *sample_cpu(void *)
{
    struct Sample { uint32_t pc, lr; };
    auto samples = static_cast<Sample *>(calloc(1000, sizeof(Sample)));
    if (!samples) { cpu_sampling.store(false); return nullptr; }
    unsigned active = 0;
    for (unsigned i = 0; i < 1000; ++i) {
        usleep(10000);
        // This higher-priority sampler preempts the single-core GUI task.
        auto tcb = nxsched_get_tcb(cpu_target);
        if (tcb && tcb->task_state == TSTATE_TASK_READYTORUN && tcb->xcp.regs) {
            samples[active++] = {tcb->xcp.regs[REG_PC], tcb->xcp.regs[REG_LR]};
        }
        if (tcb) nxsched_put_tcb(tcb);
    }
    for (unsigned i = 0; i < active; ++i)
        printf("VMC_CPU pc=%08lx lr=%08lx\n", (unsigned long)samples[i].pc, (unsigned long)samples[i].lr);
    printf("VMC_CPU complete active=%u total=1000\n", active);
    free(samples); cpu_sampling.store(false); return nullptr;
}

static void start_cpu_sample()
{
    if (cpu_sampling.exchange(true)) return;
    cpu_target = gettid();
    pthread_attr_t attr;
    pthread_attr_init(&attr);
    pthread_attr_setstacksize(&attr, 4096);
    pthread_attr_setschedpolicy(&attr, SCHED_FIFO);
    pthread_attr_setinheritsched(&attr, PTHREAD_EXPLICIT_SCHED);
    struct sched_param priority = {}; priority.sched_priority = 150;
    pthread_attr_setschedparam(&attr, &priority);
    pthread_t worker;
    int error = pthread_create(&worker, &attr, sample_cpu, nullptr);
    pthread_attr_destroy(&attr);
    if (error) { cpu_sampling.store(false); printf("VMC_CPU error=%d\n", error); }
    else { pthread_detach(worker); printf("VMC_CPU started target=%d\n", (int)cpu_target); }
}

// Small, stable page markers; ignore the clock and live training values.
static uint32_t text_marker(const char *text)
{
    if (!text) return 0;
    if (strstr(text, "小芽 ·")) return 1;
    if (!strcmp(text, "初筛")) return 2;
    if (!strcmp(text, "时间线")) return 4;
    if (!strcmp(text, "协同")) return 8;
    if (!strcmp(text, "手表桌面")) return 16;
    if (!strcmp(text, "停止") || !strcmp(text, "停止训练")) return 32;
    return 0;
}

static uint32_t page_marker(lv_obj_t *obj)
{
    if (lv_obj_has_flag(obj, LV_OBJ_FLAG_HIDDEN)) return 0;
    uint32_t marker = 0;
    if (lv_obj_has_class(obj, &lv_label_class)) {
        const char *text = lv_label_get_text(obj);
        marker |= text_marker(text);
        // Desktop titles are at y=24; button captions must not mark a page.
        if (lv_obj_get_y(obj) == 24) {
            if (!strcmp(text, "实用工具")) marker |= 64;
            if (!strcmp(text, "秒表")) marker |= 128;
            if (!strcmp(text, "快捷设置")) marker |= 256;
        }
    }
    if (lv_obj_has_class(obj, &lv_spangroup_class)) {
        // QuickApp text is a span group, including its single-line headings.
        for (unsigned i = 0; i < lv_spangroup_get_span_count(obj); ++i)
            marker |= text_marker(lv_spangroup_get_child(obj, i)->txt);
    }
    for (unsigned i = 0; i < lv_obj_get_child_count(obj); ++i)
        marker |= page_marker(lv_obj_get_child(obj, i));
    return marker;
}

static void perf_refresh(lv_event_t *event)
{
    if (!perf_enabled) return;
    if (lv_event_get_code(event) == LV_EVENT_REFR_START) {
        refresh_start = lv_tick_get();
        flush_ms = flush_pixels = flush_count = layout_ms = 0;
        return;
    }
    if (lv_event_get_code(event) == LV_EVENT_RENDER_START) {
        layout_ms = lv_tick_elaps(refresh_start);
        return;
    }
    if (lv_event_get_code(event) == LV_EVENT_FLUSH_START) {
        flush_start = lv_tick_get();
        const auto area = static_cast<const lv_area_t *>(lv_event_get_param(event));
        flush_pixels += lv_area_get_width(area) * lv_area_get_height(area);
        ++flush_count;
        return;
    }
    if (lv_event_get_code(event) == LV_EVENT_FLUSH_FINISH) {
        flush_ms += lv_tick_elaps(flush_start);
        return;
    }
    const uint32_t elapsed = lv_tick_elaps(refresh_start);
    refresh_total += elapsed;
    if (elapsed > refresh_max) refresh_max = elapsed;
    ++refresh_count;
    if (perf_trace) printf("VMC_STAGE refresh=%lu layout=%lu draw=%lu flush=%lu pixels=%lu transfers=%lu pending=%d offset=%lu\n",
        (unsigned long)elapsed, (unsigned long)layout_ms,
        (unsigned long)(elapsed >= layout_ms + flush_ms ? elapsed - layout_ms - flush_ms : 0),
        (unsigned long)flush_ms, (unsigned long)flush_pixels, (unsigned long)flush_count,
        perf_pending, (unsigned long)(perf_pending ? lv_tick_elaps(perf_start) : 0));
    if (perf_pending) {
        const uint32_t marker = page_marker(lv_screen_active());
        if (marker && marker != perf_before) {
            printf("VMC_PERF input_to_refresh_ms=%lu from=%lu to=%lu\n",
                (unsigned long)lv_tick_elaps(perf_start), (unsigned long)perf_before, (unsigned long)marker);
            perf_pending = false;
        } else if (lv_tick_elaps(perf_start) > 15000) {
            printf("VMC_PERF no_page_change timeout\n");
            perf_pending = false;
        }
    }
}

static void probe_read(lv_indev_t *, lv_indev_data_t *data)
{
    data->point = probe_point;
    data->state = probe_pressed ? LV_INDEV_STATE_PRESSED : LV_INDEV_STATE_RELEASED;
}

static unsigned count_widgets(lv_obj_t *root)
{
    unsigned result = 1;
    for (unsigned i = 0; i < lv_obj_get_child_count(root); ++i)
        result += count_widgets(lv_obj_get_child(root, i));
    return result;
}

static void snapshot()
{
    lv_obj_update_layout(lv_screen_active());
    lv_draw_buf_t *buffer = lv_snapshot_take(lv_screen_active(), LV_COLOR_FORMAT_RGB565);
    if (!buffer) { printf("VMC_PROBE snapshot allocation failed\n"); return; }
    uint32_t header[] = {buffer->header.w, buffer->header.h,
                         buffer->header.stride, buffer->data_size};
    uLongf compressed_size = compressBound(buffer->data_size);
    auto compressed = static_cast<Bytef *>(malloc(compressed_size));
    if (compressed && compress2(compressed, &compressed_size, buffer->data,
                               buffer->data_size, Z_BEST_SPEED) == Z_OK) {
        FILE *file = fopen("/data/ui-frame.z", "wb");
        bool ok = file && fwrite(header, sizeof(header), 1, file) == 1 &&
                  fwrite(compressed, 1, compressed_size, file) == compressed_size;
        if (file) fclose(file);
        printf("VMC_PROBE snapshot ok=%d width=%lu height=%lu bytes=%lu widgets=%u\n",
               ok, (unsigned long)header[0], (unsigned long)header[1],
               (unsigned long)compressed_size + sizeof(header), count_widgets(lv_screen_active()));
    } else printf("VMC_PROBE compression failed\n");
    free(compressed);
    lv_draw_buf_destroy(buffer);
}

static void probe_tick(lv_timer_t *)
{
    if (perf_enabled) {
        uint32_t gap = lv_tick_elaps(tick_last);
        if (gap > tick_gap_max) tick_gap_max = gap;
        tick_last = lv_tick_get();
    }
    if (probe_swiping && swipe_step < 8) {
        ++swipe_step;
        probe_point.x = swipe_x + swipe_dx * swipe_step / 8;
        probe_point.y = swipe_y + swipe_dy * swipe_step / 8;
        lv_indev_read(probe_input);
        if (swipe_step == 8) probe_release_pending = true;
        return;
    }
    if (probe_release_pending) {
        probe_pressed = false;
        uint32_t before_read = lv_tick_get();
        lv_indev_read(probe_input);
        if (perf_enabled && perf_trace) printf("VMC_STAGE release_at=%lu handler_ms=%lu\n",
            (unsigned long)(before_read - perf_start), (unsigned long)lv_tick_elaps(before_read));
        probe_release_pending = false;
        if (probe_swiping) printf("VMC_PROBE swipe complete\n");
        else printf("VMC_PROBE tap complete x=%ld y=%ld\n", (long)probe_point.x, (long)probe_point.y);
        probe_swiping = false;
    }
    FILE *file = fopen("/data/ui-command", "r");
    if (!file) return;
    char command[64] = {};
    fgets(command, sizeof(command), file);
    fclose(file);
    unlink("/data/ui-command");
    int x, y, x2, y2;
    if (vmc_epic_command(command)) return;
    if (!strncmp(command, "profile", 7)) { start_cpu_sample(); return; }
    if (!strncmp(command, "xip verify", 10)) {
        bool single = test_xip_mode(1);
        unsigned divider = strstr(command, "80") ? 3 : strstr(command, "60") ? 4 : 2;
        unsigned mode = strstr(command, "single") ? 1 : 2;
        bool ok = single && test_xip_mode(mode, true, divider);
        printf("VMC_XIP full_bytes=16777216 ok=%d divider=%u mode=%u bad=%08lx expected=%08lx actual=%08lx\n", ok, divider, mode,
            (unsigned long)xip_bad_address, (unsigned long)xip_expected, (unsigned long)xip_actual);
        return;
    }
    if (!strncmp(command, "xip ", 4)) {
        unsigned mode = !strncmp(command + 4, "quad", 4) ? 3 : !strncmp(command + 4, "dual", 4) ? 2 : 1;
        bool ok = test_xip_mode(mode);
        printf("VMC_XIP mode=%u ok=%d\n", mode, ok);
        return;
    }
    if (!strncmp(command, "perf on", 7) || !strncmp(command, "perf trace", 10)) {
        perf_enabled = true;
        perf_trace = !strncmp(command, "perf trace", 10);
        refresh_total = refresh_max = refresh_count = 0;
        tick_last = lv_tick_get(); tick_gap_max = 0;
        printf("VMC_PERF enabled marker=%lu\n", (unsigned long)page_marker(lv_screen_active()));
        return;
    }
    if (!strncmp(command, "perf stats", 10)) {
        printf("VMC_PERF refresh_count=%lu total_ms=%lu max_ms=%lu\n",
            (unsigned long)refresh_count, (unsigned long)refresh_total, (unsigned long)refresh_max);
        printf("VMC_STAGE timer_gap_max=%lu\n", (unsigned long)tick_gap_max);
        return;
    }
    // Runtime A/B diagnostic: both modes use the existing full-sized draw buffer.
    if (perf_enabled && !strncmp(command, "render ", 7)) {
        const bool partial = !strncmp(command + 7, "partial", 7);
        lv_display_set_render_mode(lv_display_get_default(),
            partial ? LV_DISPLAY_RENDER_MODE_PARTIAL : LV_DISPLAY_RENDER_MODE_FULL);
        lv_obj_invalidate(lv_screen_active());
        printf("VMC_STAGE render_mode=%s\n", partial ? "partial" : "full");
        return;
    }
    if (!strncmp(command, "perf off", 8)) { perf_enabled = perf_pending = false; return; }
    if (perf_enabled && (!strncmp(command, "tap ", 4) || !strncmp(command, "swipe ", 6))) {
        perf_before = page_marker(lv_screen_active());
        perf_start = lv_tick_get();
        perf_pending = true;
    }
    if (strncmp(command, "snapshot", 8) == 0) snapshot();
    else if (sscanf(command, "swipe %d %d %d %d", &x, &y, &x2, &y2) == 4) {
        int w = lv_display_get_horizontal_resolution(NULL), h = lv_display_get_vertical_resolution(NULL);
        if (x < 0 || y < 0 || x2 < 0 || y2 < 0 || x >= w || x2 >= w || y >= h || y2 >= h) {
            printf("VMC_PROBE invalid coordinates\n"); return;
        }
        swipe_x = x; swipe_y = y; swipe_dx = x2 - x; swipe_dy = y2 - y;
        swipe_step = 0; probe_swiping = true;
        probe_point.x = x; probe_point.y = y; probe_pressed = true;
        lv_indev_read(probe_input);
    }
    else if (sscanf(command, "tap %d %d", &x, &y) == 2) {
        if (x < 0 || y < 0 || x >= lv_display_get_horizontal_resolution(NULL) ||
            y >= lv_display_get_vertical_resolution(NULL)) {
            printf("VMC_PROBE invalid coordinates\n"); return;
        }
        probe_point.x = x; probe_point.y = y;
        probe_pressed = true;
        uint32_t before_read = lv_tick_get();
        lv_indev_read(probe_input);
        if (perf_enabled && perf_trace) printf("VMC_STAGE press_handler_ms=%lu\n",
            (unsigned long)lv_tick_elaps(before_read));
        probe_release_pending = true;
    } else printf("VMC_PROBE widgets=%u\n", count_widgets(lv_screen_active()));
}

extern "C" void vmc_probe_init()
{
    probe_input = lv_indev_create();
    lv_indev_set_type(probe_input, LV_INDEV_TYPE_POINTER);
    lv_indev_set_read_cb(probe_input, probe_read);
    lv_indev_set_mode(probe_input, LV_INDEV_MODE_EVENT);
    lv_timer_create(probe_tick, 100, NULL);
    lv_display_add_event_cb(lv_display_get_default(), perf_refresh, LV_EVENT_REFR_START, nullptr);
    lv_display_add_event_cb(lv_display_get_default(), perf_refresh, LV_EVENT_REFR_READY, nullptr);
    lv_display_add_event_cb(lv_display_get_default(), perf_refresh, LV_EVENT_RENDER_START, nullptr);
    lv_display_add_event_cb(lv_display_get_default(), perf_refresh, LV_EVENT_FLUSH_START, nullptr);
    lv_display_add_event_cb(lv_display_get_default(), perf_refresh, LV_EVENT_FLUSH_FINISH, nullptr);
    printf("VMC_PROBE ready\n");
}
