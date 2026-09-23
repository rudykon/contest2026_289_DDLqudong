// LVGL 9 RGB565 raster backend. Preserve software clipping, rounded-corner
// masks, gradients, text and transforms; accelerate eligible final spans.
#include <lvgl.h>
#include <src/draw/sw/blend/lv_draw_sw_blend_to_rgb565.h>
#include "vmc_epic_hw.h"
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>

extern "C" void __real_lv_draw_sw_blend_color_to_rgb565(_lv_draw_sw_blend_fill_dsc_t *);
extern "C" void __real_lv_draw_sw_blend_image_to_rgb565(_lv_draw_sw_blend_image_dsc_t *);
static bool enabled, verified;
static bool mask_verified, mask_enabled = true;
static uint64_t micros();
static uint32_t fallback_calls, fallback_pixels;
static constexpr int minimum_fill_pixels = 16384;
static constexpr int minimum_copy_pixels = 4096;

static void mismatch(const char *op, bool ran, const uint8_t *cpu, const uint8_t *hw, size_t bytes)
{
    size_t i = 0;
    while (i < bytes && cpu[i] == hw[i]) ++i;
    printf("VMC_EPIC mismatch op=%s ran=%d offset=%u cpu=%02x gpu=%02x\n", op, ran,
        (unsigned)i, i < bytes ? cpu[i] : 0, i < bytes ? hw[i] : 0);
}

extern "C" void __wrap_lv_draw_sw_blend_color_to_rgb565(_lv_draw_sw_blend_fill_dsc_t *d)
{
    if (enabled && mask_verified && mask_enabled && d->dest_w > 0 && d->dest_h > 0 &&
        d->dest_w <= 1010 && d->dest_w * d->dest_h >= 1024 &&
        (d->mask_buf || d->opa < LV_OPA_MAX) && d->opa > LV_OPA_MIN) {
        int rows = 4096 / d->dest_w;
        for (int y=0; y<d->dest_h; y+=rows) {
            int n = d->dest_h-y < rows ? d->dest_h-y : rows;
            if (vmc_epic_hw_mask(static_cast<uint8_t *>(d->dest_buf)+y*d->dest_stride,
                d->dest_stride, d->mask_buf ? d->mask_buf+y*d->mask_stride : nullptr,
                d->mask_stride, d->dest_w, n, lv_color_to_u32(d->color), d->opa >= LV_OPA_MAX ? 255 : d->opa)) continue;
            // Earlier strips are already blended. Only repair the untouched
            // suffix; re-blending the whole rectangle would apply alpha twice.
            auto rest=*d;
            rest.dest_buf=static_cast<uint8_t *>(d->dest_buf)+y*d->dest_stride;
            rest.dest_h=d->dest_h-y;
            if (d->mask_buf) rest.mask_buf=d->mask_buf+y*d->mask_stride;
            ++fallback_calls; fallback_pixels+=rest.dest_w*rest.dest_h;
            __real_lv_draw_sw_blend_color_to_rgb565(&rest);
            return;
        }
        return;
    }
    if (enabled && d->dest_w > 0 && d->dest_h > 0 &&
        d->dest_w * d->dest_h >= minimum_fill_pixels && !d->mask_buf && d->opa >= LV_OPA_MAX &&
        vmc_epic_hw_fill(d->dest_buf, d->dest_w, d->dest_h, d->dest_stride, lv_color_to_u32(d->color))) return;
    ++fallback_calls; fallback_pixels += d->dest_w * d->dest_h;
    __real_lv_draw_sw_blend_color_to_rgb565(d);
}

extern "C" void __wrap_lv_draw_sw_blend_image_to_rgb565(_lv_draw_sw_blend_image_dsc_t *d)
{
    if (enabled && d->dest_w > 0 && d->dest_h > 0 &&
        d->dest_w * d->dest_h >= minimum_copy_pixels && !d->mask_buf && d->opa >= LV_OPA_MAX &&
        d->blend_mode == LV_BLEND_MODE_NORMAL && d->src_color_format == LV_COLOR_FORMAT_RGB565 &&
        vmc_epic_hw_copy(d->dest_buf, d->dest_stride, d->src_buf, d->src_stride, d->dest_w, d->dest_h)) return;
    ++fallback_calls; fallback_pixels += d->dest_w * d->dest_h;
    __real_lv_draw_sw_blend_image_to_rgb565(d);
}

static bool self_test()
{
    // Whole allocations are compared, including dirty cache-line neighbours,
    // row padding, odd x coordinates, and clipped/subrectangle copies.
    constexpr size_t bytes = 400 * 450 * 2 + 128;
    auto cpu = static_cast<uint8_t *>(malloc(bytes));
    auto hw = static_cast<uint8_t *>(malloc(bytes));
    auto src = static_cast<uint8_t *>(malloc(bytes));
    if (!cpu || !hw || !src) { free(cpu); free(hw); free(src); return false; }
    printf("VMC_EPIC buffers cpu=%p hw=%p src=%p\n", cpu, hw, src);
    for (size_t i = 0; i < bytes; ++i) src[i] = (i * 37 + i / 127) & 255;
    struct Case { int w, h, stride, offset; uint32_t color; };
    const Case cases[] = {{1,1,34,2,0xff0000}, {129,47,514,66,0x3ebe9b},
                          {390,450,800,32,0xf4faf7}, {239,71,514,34,0x22312d}};
    bool ok = true;
    unsigned passed = 0;
    for (const auto &c : cases) {
        printf("VMC_EPIC testing fill %dx%d\n", c.w, c.h);
        memset(cpu, 0xa5, bytes); memcpy(hw, cpu, bytes);
        _lv_draw_sw_blend_fill_dsc_t fill = {};
        fill.dest_buf = cpu + c.offset; fill.dest_w = c.w; fill.dest_h = c.h;
        fill.dest_stride = c.stride; fill.opa = LV_OPA_COVER; fill.color = lv_color_hex(c.color);
        __real_lv_draw_sw_blend_color_to_rgb565(&fill);
        bool ran = vmc_epic_hw_fill(hw + c.offset, c.w, c.h, c.stride, c.color);
        if (!ran || memcmp(cpu, hw, bytes)) { mismatch("fill", ran, cpu, hw, bytes); ok = false; break; }
        ++passed;
        printf("VMC_EPIC testing copy %dx%d\n", c.w, c.h);
        memset(cpu, 0x5a, bytes); memcpy(hw, cpu, bytes);
        _lv_draw_sw_blend_image_dsc_t copy = {};
        copy.dest_buf = cpu + c.offset; copy.dest_w = c.w; copy.dest_h = c.h;
        copy.dest_stride = c.stride; copy.src_buf = src + 2; copy.src_stride = 800;
        copy.opa = LV_OPA_COVER; copy.src_color_format = LV_COLOR_FORMAT_RGB565;
        copy.blend_mode = LV_BLEND_MODE_NORMAL;
        __real_lv_draw_sw_blend_image_to_rgb565(&copy);
        ran = vmc_epic_hw_copy(hw + c.offset, c.stride, src + 2, 800, c.w, c.h);
        if (!ran || memcmp(cpu, hw, bytes)) { mismatch("copy", ran, cpu, hw, bytes); ok = false; break; }
        ++passed;
    }
    // Inject a transfer failure and verify CPU fallback repairs the whole fill.
    if (ok) {
        printf("VMC_EPIC testing fault fallback\n");
        memset(cpu, 0x39, bytes); memcpy(hw, cpu, bytes);
        _lv_draw_sw_blend_fill_dsc_t d = {};
        d.dest_buf = cpu + 34; d.dest_w = 239; d.dest_h = 71; d.dest_stride = 514;
        d.color = lv_color_hex(0x62a9e8); d.opa = LV_OPA_COVER;
        __real_lv_draw_sw_blend_color_to_rgb565(&d);
        d.dest_buf = hw + 34;
        ok = vmc_epic_hw_fill(d.dest_buf, 239, 8, 514, 0x62a9e8);
        enabled = true; vmc_epic_hw_inject_fault();
        __wrap_lv_draw_sw_blend_color_to_rgb565(&d);
        enabled = false;
        ok = ok && !memcmp(cpu, hw, bytes) && vmc_epic_hw_init();
        if (ok) ++passed;
    }
    free(cpu); free(hw); free(src);
    struct vmc_epic_stats s;
    vmc_epic_hw_stats(&s, true);
    fallback_calls = fallback_pixels = 0;
    printf("VMC_EPIC selftest=%d cases=%u max_irq_us=%lu faults=%lu\n", ok, passed,
           (unsigned long)s.max_irq_us, (unsigned long)s.faults);
    return ok;
}

static bool mask_test()
{
    constexpr int w = 39, h = 41, stride = 96, bytes = stride * h + 128;
    auto cpu = static_cast<uint8_t *>(malloc(bytes));
    auto hw = static_cast<uint8_t *>(malloc(bytes));
    auto mask = static_cast<uint8_t *>(malloc(64 * h));
    if (!cpu || !hw || !mask) { free(cpu); free(hw); free(mask); return false; }
    for (int i = 0; i < 64*h; ++i) mask[i] = i % 7 == 0 ? 0 : i % 7 == 1 ? 255 : (i*37)&255;
    const int opacities[] = {255, 128, 37};
    bool ok = true; unsigned max_delta = 0, changed = 0, cases = 0;
    for (int masked = 0; masked < 2; ++masked) for (int opacity : opacities) {
        unsigned case_delta = 0;
        for (int i = 0; i < bytes; ++i) cpu[i] = (i*29 + i/13)&255;
        memcpy(hw, cpu, bytes);
        _lv_draw_sw_blend_fill_dsc_t d = {};
        d.dest_buf = cpu + 34; d.dest_w = w; d.dest_h = h; d.dest_stride = stride;
        d.color = lv_color_hex(0x396ba7); d.opa = opacity;
        d.mask_buf = masked ? mask + 1 : nullptr; d.mask_stride = 64;
        __real_lv_draw_sw_blend_color_to_rgb565(&d);
        bool ran = vmc_epic_hw_mask(hw+34, stride, d.mask_buf, 64, w, h, 0x396ba7, opacity);
        if (!ran) ok = false;
        for (int i = 0; i < bytes; i += 2) {
            int offset = i - 34;
            bool inside = offset >= 0 && offset / stride < h && offset % stride < w*2;
            uint16_t a, b; memcpy(&a, cpu+i, 2); memcpy(&b, hw+i, 2);
            if (a != b) ++changed;
            if (!inside && a != b) ok = false;
            for (int channel = 0; channel < 3; ++channel) {
                int shift = channel == 0 ? 11 : channel == 1 ? 5 : 0;
                int bits = channel == 1 ? 63 : 31;
                unsigned delta = abs(int((a>>shift)&bits) - int((b>>shift)&bits));
                if (delta > max_delta) max_delta = delta;
                if (delta > case_delta) case_delta = delta;
                if (delta > 1) ok = false;
            }
        }
        ++cases;
        printf("VMC_EPIC mask_case masked=%d opacity=%d ran=%d delta=%u\n",masked,opacity,ran,case_delta);
    }
    // A failed blend must not touch the original destination at all.
    memcpy(hw, cpu, bytes); vmc_epic_hw_inject_fault();
    bool failed = !vmc_epic_hw_mask(hw+34, stride, mask+1, 64, w, h, 0x396ba7, 128);
    ok = failed && !memcmp(hw, cpu, bytes) && vmc_epic_hw_init() && ok;
    if (ok) ++cases;
    _lv_draw_sw_blend_fill_dsc_t d = {};
    d.dest_buf = cpu+34; d.dest_w=w; d.dest_h=h; d.dest_stride=stride;
    d.color=lv_color_hex(0x396ba7); d.opa=255; d.mask_buf=mask+1; d.mask_stride=64;
    auto t=micros(); for(int i=0;i<20;++i) __real_lv_draw_sw_blend_color_to_rgb565(&d);
    auto sw=(micros()-t)/20;
    t=micros(); for(int i=0;i<20;++i) vmc_epic_hw_mask(hw+34,stride,mask+1,64,w,h,0x396ba7,255);
    auto gpu=(micros()-t)/20;
    printf("VMC_EPIC mask_selftest=%d cases=%u changed=%u max_channel_delta=%u cpu_us=%lu gpu_us=%lu\n",
        ok,cases,changed,max_delta,(unsigned long)sw,(unsigned long)gpu);
    free(cpu);free(hw);free(mask);
    struct vmc_epic_stats s; vmc_epic_hw_stats(&s,true);
    return ok;
}

extern "C" void vmc_epic_init()
{
    verified = vmc_epic_hw_init() && self_test();
    mask_verified = verified && mask_test();
    enabled = verified;
    printf("VMC_EPIC backend=%s min_fill_pixels=%d min_copy_pixels=%d\n",
        enabled ? "hardware" : "software", minimum_fill_pixels, minimum_copy_pixels);
}

static uint64_t micros()
{
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return uint64_t(t.tv_sec) * 1000000 + t.tv_nsec / 1000;
}

static void benchmark()
{
    auto dst = static_cast<uint8_t *>(malloc(390 * 450 * 2));
    auto src = static_cast<uint8_t *>(malloc(390 * 450 * 2));
    if (!dst || !src) { free(dst); free(src); return; }
    memset(src, 0x53, 390 * 450 * 2);
    const int heights[] = {16, 100, 450};
    for (int h : heights) {
        _lv_draw_sw_blend_fill_dsc_t f = {};
        f.dest_buf = dst; f.dest_w = 390; f.dest_h = h; f.dest_stride = 780;
        f.opa = LV_OPA_COVER; f.color = lv_color_hex(0x3ebe9b);
        _lv_draw_sw_blend_image_dsc_t c = {};
        c.dest_buf = dst; c.dest_w = 390; c.dest_h = h; c.dest_stride = 780;
        c.src_buf = src; c.src_stride = 780; c.opa = LV_OPA_COVER;
        c.src_color_format = LV_COLOR_FORMAT_RGB565; c.blend_mode = LV_BLEND_MODE_NORMAL;
        uint64_t times[4]; bool ok = true;
        for (int op = 0; op < 4; ++op) {
            uint64_t start = micros();
            for (int i = 0; i < 10; ++i) {
                if (op == 0) __real_lv_draw_sw_blend_color_to_rgb565(&f);
                if (op == 1) ok = vmc_epic_hw_fill(dst, 390, h, 780, 0x3ebe9b) && ok;
                if (op == 2) __real_lv_draw_sw_blend_image_to_rgb565(&c);
                if (op == 3) ok = vmc_epic_hw_copy(dst, 780, src, 780, 390, h) && ok;
            }
            times[op] = (micros() - start) / 10;
        }
        printf("VMC_EPIC bench pixels=%d ok=%d fill_cpu_us=%lu fill_gpu_us=%lu copy_cpu_us=%lu copy_gpu_us=%lu\n",
            390*h, ok, (unsigned long)times[0], (unsigned long)times[1], (unsigned long)times[2], (unsigned long)times[3]);
    }
    free(dst); free(src);
}

static void mask_benchmark()
{
    auto dst=static_cast<uint8_t *>(malloc(780*64));
    auto mask=static_cast<uint8_t *>(malloc(4096));
    if (!dst || !mask) {free(dst);free(mask);return;}
    memset(dst,0x71,780*64);
    const int heights[]={16,32,64};
    for(int sparse=0;sparse<2;++sparse) {
        for(int i=0;i<4096;++i) mask[i]=sparse ? ((i%10<8)?(i&1?255:0):127) : (i*37)&255;
        for(int h:heights) {
            _lv_draw_sw_blend_fill_dsc_t d={};
            d.dest_buf=dst;d.dest_stride=780;d.dest_w=64;d.dest_h=h;
            d.mask_buf=mask;d.mask_stride=64;d.opa=255;d.color=lv_color_hex(0x396ba7);
            auto t=micros();for(int i=0;i<20;++i)__real_lv_draw_sw_blend_color_to_rgb565(&d);
            auto sw=(micros()-t)/20;
            bool ok=true;t=micros();for(int i=0;i<20;++i)ok=vmc_epic_hw_mask(dst,780,mask,64,64,h,0x396ba7,255)&&ok;
            auto gpu=(micros()-t)/20;
            printf("VMC_EPIC mask_bench pixels=%d sparse=%d ok=%d cpu_us=%lu gpu_us=%lu\n",
                64*h,sparse,ok,(unsigned long)sw,(unsigned long)gpu);
        }
    }
    free(dst);free(mask);
}

extern "C" bool vmc_epic_command(const char *command)
{
    if (strncmp(command, "gpu ", 4)) return false;
    if (!strncmp(command+4, "mask on", 7)) mask_enabled=true;
    else if (!strncmp(command+4, "mask off", 8)) mask_enabled=false;
    else if (!strncmp(command+4, "mask bench", 10)) mask_benchmark();
    if (!strncmp(command + 4, "on", 2)) enabled = verified && vmc_epic_hw_ready();
    else if (!strncmp(command + 4, "off", 3)) enabled = false;
    else if (!strncmp(command + 4, "bench", 5)) benchmark();
    struct vmc_epic_stats s;
    bool reset = !strncmp(command + 4, "reset", 5);
    vmc_epic_hw_stats(&s, reset);
    printf("VMC_EPIC enabled=%d verified=%d fills=%lu copies=%lu pixels=%lu fallbacks=%lu fallback_pixels=%lu faults=%lu max_irq_us=%lu blends=%lu mask_verified=%d mask_enabled=%d\n",
        enabled && vmc_epic_hw_ready(), verified, (unsigned long)s.fills, (unsigned long)s.copies, (unsigned long)s.pixels,
        (unsigned long)fallback_calls, (unsigned long)fallback_pixels,
        (unsigned long)s.faults, (unsigned long)s.max_irq_us, (unsigned long)s.blends, mask_verified, mask_enabled);
    if (reset) fallback_calls = fallback_pixels = 0;
    return true;
}
