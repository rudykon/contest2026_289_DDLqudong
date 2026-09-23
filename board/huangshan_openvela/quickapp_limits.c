#include <nuttx/config.h>
#include <stdint.h>
#include <stdio.h>

/* This pinned prebuilt QApplicationCreate ignores CreateInfo.heap_size and
 * initializes QuickJS with its compiled-in 1 MiB default. Honor the board's
 * configured budget at the exported QuickJS setter, without modifying the
 * proprietary archive. Preserve the runtime's emergency SIZE_MAX setting.
 */
extern void __real_JS_SetMemoryLimit(void *runtime, size_t limit);
void __wrap_JS_SetMemoryLimit(void *runtime, size_t limit)
{
  size_t effective = limit;
  if (limit != SIZE_MAX && limit < CONFIG_QUICKAPP_JSHEAPSIZE)
    effective = CONFIG_QUICKAPP_JSHEAPSIZE;
  printf("VMC_JS_HEAP requested=%lu effective=%lu\n",
         (unsigned long)limit, (unsigned long)effective);
  __real_JS_SetMemoryLimit(runtime, effective);
}
