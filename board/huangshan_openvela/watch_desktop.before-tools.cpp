// Board-owned LVGL launcher; the QuickApp lives on a separate screen.
#include "common/shell_app.h"
#include <lvgl.h>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <memory>
#include <string>

namespace {
lv_obj_t *desktop, *app_screen, *clock_label, *date_label, *status_label, *launch_label, *home_button;
lv_font_t *large_font, *title_font, *small_font;
std::shared_ptr<shell::ShellApp> running_app;
MessageLoop *message_loop;
uv_loop_t *uv_loop;
std::string app_uri;
enum Pending { NONE, OPEN, HOME };
Pending pending = NONE;
bool desktop_visible = true;
time_t last_clock = 0;

lv_obj_t *label(lv_obj_t *parent, const char *text, int y, int height,
                const lv_font_t *font, uint32_t color)
{
    auto obj = lv_label_create(parent);
    lv_obj_set_pos(obj, 39, y);
    lv_obj_set_size(obj, 312, height);
    lv_obj_set_style_text_font(obj, font, 0);
    lv_obj_set_style_text_color(obj, lv_color_hex(color), 0);
    lv_obj_set_style_text_align(obj, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_text(obj, text);
    return obj;
}

void update_clock()
{
    const time_t now = time(nullptr);
    if (now / 60 == last_clock / 60 && last_clock != 0) return;
    last_clock = now;
    if (now < 1735689600) {
        lv_label_set_text(clock_label, "--:--");
        lv_label_set_text(date_label, "时间未设置");
        return;
    }
    const time_t china = now + 8 * 3600;
    struct tm local;
    gmtime_r(&china, &local);
    char text[64];
    snprintf(text, sizeof(text), "%02d:%02d", local.tm_hour, local.tm_min);
    lv_label_set_text(clock_label, text);
    const char *days[] = {"周日", "周一", "周二", "周三", "周四", "周五", "周六"};
    snprintf(text, sizeof(text), "%02d月%02d日  %s", local.tm_mon + 1, local.tm_mday, days[local.tm_wday]);
    lv_label_set_text(date_label, text);
}

class DesktopObserver : public shell::ShellApp::Observer {
public:
    void onNotifyEvent(shell::ShellApp *, int event, void *) override
    {
        // This single-app host treats a framework home/exit request as
        // backgrounding. The explicit native Home key follows the same policy.
        if (event == QAPP_EVENT_REQ_EXIT) pending = HOME;
    }
};

void tick(lv_timer_t *)
{
    const Pending operation = pending;
    pending = NONE;
    if (operation == HOME && running_app && !desktop_visible) {
        running_app->hide();
        lv_obj_add_flag(home_button, LV_OBJ_FLAG_HIDDEN);
        lv_screen_load(desktop);
        desktop_visible = true;
        lv_label_set_text(status_label, "小芽在后台运行");
        lv_label_set_text(launch_label, "返回小芽");
        printf("VMC_DESKTOP home app_preserved=1\n");
    } else if (operation == OPEN && desktop_visible) {
        if (!app_screen) app_screen = lv_obj_create(nullptr);
        lv_screen_load(app_screen);
        desktop_visible = false;
        if (!running_app) {
            running_app = shell::ShellApp::Create(app_uri.c_str(), message_loop,
                std::make_unique<shell::ShellApp::Delegate>(), false);
            running_app->addObserver(std::make_unique<DesktopObserver>());
            running_app->setUILoop(uv_loop);
            running_app->create((NativeWidgetHandle)app_screen);
            printf("VMC_DESKTOP launch\n");
        } else {
            running_app->show();
            printf("VMC_DESKTOP resume\n");
        }
        lv_obj_remove_flag(home_button, LV_OBJ_FLAG_HIDDEN);
    }
    if (desktop_visible) update_clock();
}
}

extern "C" bool watch_desktop_init(MessageLoop *messages, uv_loop_t *loop, const char *uri)
{
    message_loop = messages;
    uv_loop = loop;
    app_uri = uri;
    const char *font = "/etc/data/font/MiSans-Regular.ttf";
    large_font = lv_freetype_font_create(font, LV_FREETYPE_FONT_RENDER_MODE_BITMAP, 76, LV_FREETYPE_FONT_STYLE_NORMAL);
    title_font = lv_freetype_font_create(font, LV_FREETYPE_FONT_RENDER_MODE_BITMAP, 34, LV_FREETYPE_FONT_STYLE_NORMAL);
    small_font = lv_freetype_font_create(font, LV_FREETYPE_FONT_RENDER_MODE_BITMAP, 26, LV_FREETYPE_FONT_STYLE_NORMAL);
    if (!large_font || !title_font || !small_font) {
        printf("VMC_DESKTOP font initialization failed\n");
        return false;
    }
    desktop = lv_screen_active();
    lv_obj_set_style_bg_color(desktop, lv_color_hex(0xF4FAF7), 0);
    lv_obj_set_style_bg_opa(desktop, LV_OPA_COVER, 0);
    lv_obj_remove_flag(desktop, LV_OBJ_FLAG_SCROLLABLE);
    label(desktop, "手表桌面", 24, 46, title_font, 0x22312D);
    clock_label = label(desktop, "--:--", 102, 96, large_font, 0x16755A);
    date_label = label(desktop, "时间未设置", 202, 40, small_font, 0x42514B);
    status_label = label(desktop, "北京时间", 249, 38, small_font, 0x42514B);
    auto button = lv_button_create(desktop);
    lv_obj_set_pos(button, 39, 303);
    lv_obj_set_size(button, 312, 78);
    lv_obj_set_style_bg_color(button, lv_color_hex(0x239B78), 0);
    lv_obj_set_style_radius(button, 24, 0);
    lv_obj_set_style_shadow_width(button, 0, 0);
    lv_obj_add_event_cb(button, [](lv_event_t *) { pending = OPEN; }, LV_EVENT_CLICKED, nullptr);
    launch_label = lv_label_create(button);
    lv_obj_set_style_text_font(launch_label, title_font, 0);
    lv_obj_set_style_text_color(launch_label, lv_color_hex(0xFFFFFF), 0);
    lv_label_set_text(launch_label, "小芽运动");
    lv_obj_center(launch_label);
    label(desktop, "点桌面键返回", 400, 36, small_font, 0x42514B);
    // A host-owned key is independent of optional QuickApp system features.
    // It covers the matching application key, in the same corner-safe bounds.
    home_button = lv_button_create(lv_layer_top());
    lv_obj_set_pos(home_button, 68, 377);
    lv_obj_set_size(home_button, 117, 59);
    lv_obj_set_style_bg_color(home_button, lv_color_hex(0xDFF6EE), 0);
    lv_obj_set_style_radius(home_button, 20, 0);
    lv_obj_set_style_shadow_width(home_button, 0, 0);
    auto home_text = lv_label_create(home_button);
    lv_obj_set_style_text_font(home_text, title_font, 0);
    lv_obj_set_style_text_color(home_text, lv_color_hex(0x16755A), 0);
    lv_label_set_text(home_text, "桌面");
    lv_obj_center(home_text);
    lv_obj_add_event_cb(home_button, [](lv_event_t *) { pending = HOME; }, LV_EVENT_CLICKED, nullptr);
    lv_obj_add_flag(home_button, LV_OBJ_FLAG_HIDDEN);
    lv_timer_create(tick, 100, nullptr);
    update_clock();
    printf("VMC_DESKTOP ready\n");
    return true;
}
