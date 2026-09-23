#include "quickapp.h"
#include "feature_exports.h"
#include <ash/message_loop/cmessage_loop.h>
#include <lvgl.h>
#include <uikit/uikit.h>
#include <uv.h>

extern "C" void vmc_probe_init();
extern "C" void vmc_xip_init();
extern "C" void vmc_epic_init();
extern "C" bool watch_desktop_init(MessageLoop *, uv_loop_t *, const char *);

extern "C" int main(int argc, const char **argv)
{
    if (argc < 2) return 1;
    vmc_xip_init();
    GUIWidgetInit();
    lv_init();
    vmc_epic_init();
    lv_nuttx_dsc_t info;
    lv_nuttx_result_t result;
    lv_nuttx_dsc_init(&info);
    lv_nuttx_init(&info, &result);
    // Keep the allocated full-sized RGB565 buffer, but redraw only damaged
    // rectangles. FULL mode repaints all 175500 pixels for a button press.
    lv_display_set_render_mode(lv_display_get_default(), LV_DISPLAY_RENDER_MODE_PARTIAL);
    vg_init();
    uv_loop_t loop;
    uv_loop_init(&loop);
    GuiDataHandle gui_loop_data = GUILoopStart(&loop);
    MessageLoop *ui_message_loop = MessageLoop_CreateForUV(&loop);
    if (!watch_desktop_init(ui_message_loop, &loop, argv[1])) return 2;
    vmc_probe_init();
    uv_run(&loop, UV_RUN_DEFAULT);
    MessageLoop_Destroy(ui_message_loop);
    GUILoopStop(gui_loop_data);
    GUIWidgetUninit();
    return 0;
}
