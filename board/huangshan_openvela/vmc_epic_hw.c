/* SF32LB52 EPIC adapter for NuttX. Only opaque, idempotent operations are
 * submitted: once DMA is quiescent, CPU can replace a partially drawn result.
 * Copyright 2026. SPDX-License-Identifier: Apache-2.0 */
#include "vmc_epic_hw.h"
#include "bf0_hal.h"
#include <nuttx/cache.h>
#include <nuttx/irq.h>
#include <string.h>

static EPIC_HandleTypeDef gpu;
static EZIP_HandleTypeDef ezip;
static struct vmc_epic_stats stats;
static bool ready, inject_fault;
static uint32_t cycles_per_us = 240;
/* Blend into private storage: destination stays untouched on failure, so
 * software fallback never applies alpha a second time to a partial result. */
static uint16_t blend_result[4096] __attribute__((aligned(32)));
static uint8_t solid_alpha[4096] __attribute__((aligned(32)));
static uint32_t coverage_palette[256];
static int coverage_opacity = -1;
static uint32_t coverage_rgb;

static bool ram_region(uintptr_t first, uintptr_t end)
{
    return end > first && ((first >= 0x20000000u && end <= 0x20080000u) ||
                           (first >= 0x60000000u && end <= 0x60800000u));
}

static bool valid(const void *data, int w, int h, int stride)
{
    if (!data || ((uintptr_t)data & 1) || w < 1 || h < 1 || w > 1010 || h > 1010 ||
        stride < w * 2 || stride > 2046 || (stride & 1)) return false;
    return ram_region((uintptr_t)data, (uintptr_t)data + (h - 1) * stride + w * 2);
}

static void clean_region(const void *data, int w, int h, int stride)
{
    if (h > 1 && stride > w * 2 + 64) {
        for (int y = 0; y < h; ++y) clean_region((const uint8_t *)data + y * stride, w, 1, stride);
        return;
    }
    uintptr_t first = (uintptr_t)data & ~(uintptr_t)31;
    uintptr_t end = ((uintptr_t)data + (h - 1) * stride + w * 2 + 31) & ~(uintptr_t)31;
    up_clean_dcache(first, end);
}

static void invalidate_region(void *data, int w, int h, int stride)
{
    if (h > 1 && stride > w * 2 + 64) {
        for (int y = 0; y < h; ++y) invalidate_region((uint8_t *)data + y * stride, w, 1, stride);
        return;
    }
    uintptr_t first = (uintptr_t)data & ~(uintptr_t)31;
    uintptr_t end = ((uintptr_t)data + (h - 1) * stride + w * 2 + 31) & ~(uintptr_t)31;
    up_invalidate_dcache(first, end);
}

bool vmc_epic_hw_init(void)
{
    irqstate_t irq = up_irq_save();
    ready = false;
    memset(solid_alpha, 255, sizeof(solid_alpha));
    NVIC_DisableIRQ(EPIC_IRQn);
    NVIC_ClearPendingIRQ(EPIC_IRQn);
    HAL_RCC_EnableModule(RCC_MOD_EPIC);
    HAL_RCC_ResetModule(RCC_MOD_EPIC);
    memset(&gpu, 0, sizeof(gpu));
    memset(&ezip, 0, sizeof(ezip));
    gpu.Instance = hwp_epic;
    ezip.Instance = hwp_ezip1;
    gpu.hezip = &ezip;
    if (HAL_EZIP_Init(&ezip) == HAL_OK && HAL_EPIC_Init(&gpu) == HAL_OK) {
        CoreDebug->DEMCR |= CoreDebug_DEMCR_TRCENA_Msk;
        DWT->CTRL |= DWT_CTRL_CYCCNTENA_Msk;
        cycles_per_us = HAL_RCC_GetHCLKFreq(CORE_ID_HCPU) / 1000000;
        if (!cycles_per_us) cycles_per_us = 240;
        ready = true;
    }
    up_irq_restore(irq);
    return ready;
}

static bool finish(HAL_StatusTypeDef status, uint32_t started)
{
    bool ok = status == HAL_OK;
    inject_fault = false;
    /* The polling HAL API has an unbounded wait. Use its IT start and complete
     * it ourselves with a cycle deadline, keeping the NVIC interrupt disabled.
     * Cache-line neighbours cannot be changed by another CPU task between
     * clean and invalidate: this short DMA operation is inside a critical
     * section. Bound it to 10 ms, including setup. Normal time is measured. */
    unsigned spins = 0;
    __DSB();
    while (ok && (gpu.Instance->STATUS || !(gpu.Instance->EOF_IRQ & EPIC_EOF_IRQ_IRQ_CAUSE))) {
        if ((uint32_t)(DWT->CYCCNT - started) > cycles_per_us * 10000u || ++spins > 300000u) ok = false;
    }
    __DSB();
    if (ok) {
        HAL_EPIC_IRQHandler(&gpu);
        ok = gpu.State == HAL_EPIC_STATE_READY && !gpu.ErrorCode;
    }
    if (!ok) {
        HAL_RCC_ResetModule(RCC_MOD_EPIC);
        __DSB();
        ready = false;
        ++stats.faults;
    }
    NVIC_ClearPendingIRQ(EPIC_IRQn);
    return ok;
}

static void elapsed(uint32_t started)
{
    uint32_t us = (uint32_t)(DWT->CYCCNT - started) / cycles_per_us;
    if (us > stats.max_irq_us) stats.max_irq_us = us;
}

static bool fill_strip(void *dst, int w, int h, int stride, uint32_t rgb)
{
    if (!ready || !valid(dst, w, h, stride)) return false;
    irqstate_t irq = up_irq_save();
    uint32_t started = DWT->CYCCNT;
    clean_region(dst, w, h, stride);
    EPIC_FillingCfgTypeDef fill = {0};
    fill.start = dst; fill.color_mode = EPIC_COLOR_RGB565;
    fill.width = w; fill.height = h; fill.total_width = stride / 2;
    fill.color_r = rgb >> 16; fill.color_g = rgb >> 8; fill.color_b = rgb;
    fill.alpha = 255;
    /* Inject before submission: resetting an active bus master is not a safe
     * way to manufacture a test failure. The self-test pre-fills one strip
     * separately to exercise repair of a partially drawn destination. */
    bool ok = finish(inject_fault ? HAL_ERROR : HAL_EPIC_FillStart_IT(&gpu, &fill), started);
    invalidate_region(dst, w, h, stride);
    if (ok) { ++stats.fills; stats.pixels += w * h; }
    elapsed(started);
    up_irq_restore(irq);
    return ok;
}

static bool copy_strip(void *dst, int stride, const void *src, int src_stride, int w, int h)
{
    if (!ready || !valid(dst, w, h, stride) || !valid(src, w, h, src_stride)) return false;
    uintptr_t d = (uintptr_t)dst, s = (uintptr_t)src;
    if (d < s + (h - 1) * src_stride + w * 2 && s < d + (h - 1) * stride + w * 2) return false;
    irqstate_t irq = up_irq_save();
    uint32_t started = DWT->CYCCNT;
    clean_region(dst, w, h, stride);
    clean_region(src, w, h, src_stride);
    EPIC_BlendingDataType input, output;
    HAL_EPIC_BlendDataInit(&input); HAL_EPIC_BlendDataInit(&output);
    input.data = (uint8_t *)src; output.data = dst;
    input.color_mode = output.color_mode = EPIC_COLOR_RGB565;
    input.width = output.width = w; input.height = output.height = h;
    input.total_width = src_stride / 2; output.total_width = stride / 2;
    bool ok = finish(inject_fault ? HAL_ERROR : HAL_EPIC_Copy_IT(&gpu, &input, &output), started);
    invalidate_region(dst, w, h, stride);
    if (ok) { ++stats.copies; stats.pixels += w * h; }
    elapsed(started);
    up_irq_restore(irq);
    return ok;
}

/* Release interrupts between strips. Keep each transfer below 4096 pixels;
 * counters count hardware strips, not LVGL draw calls. */
bool vmc_epic_hw_fill(void *dst, int w, int h, int stride, uint32_t rgb)
{
    if (!ready || !valid(dst, w, h, stride)) return false;
    int rows = 4096 / w;
    for (int y = 0; y < h; y += rows) {
        int n = h - y < rows ? h - y : rows;
        if (!fill_strip((uint8_t *)dst + y * stride, w, n, stride, rgb)) return false;
    }
    return true;
}

bool vmc_epic_hw_copy(void *dst, int stride, const void *src, int src_stride, int w, int h)
{
    if (!ready || !valid(dst, w, h, stride) || !valid(src, w, h, src_stride)) return false;
    uintptr_t d = (uintptr_t)dst, s = (uintptr_t)src;
    if (d < s + (h - 1) * src_stride + w * 2 && s < d + (h - 1) * stride + w * 2) return false;
    int rows = 4096 / w;
    for (int y = 0; y < h; y += rows) {
        int n = h - y < rows ? h - y : rows;
        if (!copy_strip((uint8_t *)dst + y * stride, stride,
                        (const uint8_t *)src + y * src_stride, src_stride, w, n)) return false;
    }
    return true;
}

bool vmc_epic_hw_mask(void *dst, int stride, const uint8_t *mask, int mask_stride,
                      int w, int h, uint32_t rgb, uint8_t opacity)
{
    if (!ready || !valid(dst, w, h, stride) || w * h > 4096) return false;
    if (!mask) { mask = solid_alpha; mask_stride = w; }
    if (mask_stride < w || mask_stride > 2046 ||
        !ram_region((uintptr_t)mask, (uintptr_t)mask + (h - 1) * mask_stride + w)) return false;
    bool indexed = mask != solid_alpha;
    if (indexed) {
        /* LVGL RGB565 rounds coverage to 5 bits. Match that rule before
         * handing A8 data to EPIC; otherwise antialiased edges differ by
         * more than a destination-channel quantization level. */
        if (coverage_opacity != opacity || coverage_rgb != rgb) {
            for (unsigned i = 0; i < 256; ++i) {
                unsigned alpha = opacity == 255 ? i : (i * opacity) >> 8;
                alpha = ((alpha + 4) >> 3) << 3;
                coverage_palette[i] = ((alpha > 255 ? 255 : alpha) << 24) | (rgb & 0xf8fcf8);
            }
            coverage_opacity = opacity;
            coverage_rgb = rgb;
        }
        // Treat A8 coverage as an L8 index. Hardware CLUT performs the
        // quantization without a CPU conversion pass over every glyph pixel.
        opacity = 255;
    } else {
        unsigned alpha = ((opacity + 4u) >> 3) << 3;
        opacity = alpha > 255 ? 255 : alpha;
    }
    irqstate_t irq = up_irq_save();
    uint32_t started = DWT->CYCCNT;
    clean_region(dst, w, h, stride);
    up_clean_dcache((uintptr_t)mask & ~(uintptr_t)31,
        ((uintptr_t)mask + (h - 1) * mask_stride + w + 31) & ~(uintptr_t)31);
    clean_region(blend_result, w, h, w * 2);
    EPIC_BlendingDataType fg, bg, out;
    HAL_EPIC_BlendDataInit(&fg); HAL_EPIC_BlendDataInit(&bg); HAL_EPIC_BlendDataInit(&out);
    fg.data = (uint8_t *)mask; fg.color_mode = indexed ? EPIC_COLOR_L8 : EPIC_COLOR_A8;
    fg.width = bg.width = out.width = w;
    fg.height = bg.height = out.height = h;
    fg.total_width = mask_stride;
    fg.color_en = !indexed; fg.ax_mode = ALPHA_BLEND_RGBCOLOR;
    if (indexed) { fg.lookup_table = (uint8_t *)coverage_palette; fg.lookup_table_size = 256; }
    fg.color_r = (rgb >> 16) & 0xf8; fg.color_g = (rgb >> 8) & 0xfc; fg.color_b = rgb & 0xf8;
    bg.data = dst; bg.color_mode = out.color_mode = EPIC_COLOR_RGB565;
    bg.total_width = stride / 2;
    out.data = (uint8_t *)blend_result; out.total_width = w;
    bool ok = finish(inject_fault ? HAL_ERROR : HAL_EPIC_BlendStart_IT(&gpu, &fg, &bg, &out, opacity), started);
    invalidate_region(blend_result, w, h, w * 2);
    if (ok) {
        for (int y = 0; y < h; ++y) {
            /* Both buffers are 16-bit aligned. Explicit halfword stores avoid
             * the byte-copy libc path for odd-x clipped glyph rectangles. */
            volatile uint16_t *target = (uint16_t *)((uint8_t *)dst + y * stride);
            const uint16_t *source = blend_result + y * w;
            int x=0;
            for (; x+3<w; x+=4) {
                target[x]=source[x]; target[x+1]=source[x+1];
                target[x+2]=source[x+2]; target[x+3]=source[x+3];
            }
            for (; x<w; ++x) target[x]=source[x];
        }
        ++stats.blends; stats.pixels += w * h;
    }
    elapsed(started);
    up_irq_restore(irq);
    return ok;
}

void vmc_epic_hw_stats(struct vmc_epic_stats *out, bool reset)
{
    *out = stats;
    if (reset) memset(&stats, 0, sizeof(stats));
}

void vmc_epic_hw_inject_fault(void) { inject_fault = true; }
bool vmc_epic_hw_ready(void) { return ready; }
