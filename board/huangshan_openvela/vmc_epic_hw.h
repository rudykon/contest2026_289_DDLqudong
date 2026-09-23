#pragma once
#include <stdbool.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
struct vmc_epic_stats {
    uint32_t fills, copies, pixels, faults, max_irq_us, blends;
};
bool vmc_epic_hw_init(void);
bool vmc_epic_hw_ready(void);
bool vmc_epic_hw_fill(void *dst, int width, int height, int stride, uint32_t rgb);
bool vmc_epic_hw_copy(void *dst, int stride, const void *src, int src_stride, int width, int height);
void vmc_epic_hw_stats(struct vmc_epic_stats *out, bool reset);
void vmc_epic_hw_inject_fault(void);
bool vmc_epic_hw_mask(void *dst, int stride, const uint8_t *mask, int mask_stride,
                      int width, int height, uint32_t rgb, uint8_t opacity);
#ifdef __cplusplus
}
#endif
