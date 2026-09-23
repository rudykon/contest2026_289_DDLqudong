// Native desktop tools; the QuickApp keeps its separate screen and state.
#include "common/shell_app.h"
#include "watch_tools.h"
#include <lvgl.h>
#include <nuttx/lcd/lcd_dev.h>
#include <sys/ioctl.h>
#include <fcntl.h>
#include <unistd.h>
#include <cstdio>
#include <ctime>
#include <memory>
#include <string>
#include <atomic>

namespace {
enum Page { MAIN, TOOLS, STOPWATCH, COUNTDOWN, SETTINGS, CLOCK, ABOUT, LOCK, ALERT, APP };
enum Action { NONE, OPEN, HOME, TOOLS_GO, STOPWATCH_GO, COUNTDOWN_GO, SETTINGS_GO,
    CLOCK_GO, ABOUT_GO, LOCK_GO, UNLOCK, BACK, SW_TOGGLE, SW_RESET, CD_TOGGLE,
    CD_RESET, CD_MINUS, CD_PLUS, DIM, BRIGHT, FIELD, MINUS, PLUS, SAVE, ACK };
Page page=MAIN, alert_return=MAIN;
Action pending=NONE;
std::atomic<bool> app_return_requested{false};
lv_obj_t *desktop, *app_screen, *home_button, *value_label, *detail_label, *state_label;
lv_font_t *large_font, *timer_font, *title_font, *small_font;
std::shared_ptr<shell::ShellApp> running_app;
MessageLoop *message_loop;
uv_loop_t *uv_loop;
std::string app_uri;
watch::Stopwatch stopwatch;
watch::Countdown countdown;
watch::Calendar calendar;
int field=0, brightness=80;
uint64_t last_value=UINT64_MAX;
bool clock_error=false, brightness_error=false;
const uint32_t BG=0xF4FAF7, INK=0x22312D, GREEN=0x16755A;

uint64_t monotonic_ms() {
    struct timespec ts; clock_gettime(CLOCK_MONOTONIC,&ts);
    return static_cast<uint64_t>(ts.tv_sec)*1000+ts.tv_nsec/1000000;
}
void show(Page next);
lv_obj_t *label(const char *text,int y,int height,const lv_font_t *font,uint32_t color=INK) {
    auto obj=lv_label_create(desktop);
    lv_obj_set_pos(obj,39,y); lv_obj_set_size(obj,312,height);
    lv_obj_set_style_text_font(obj,font,0);
    lv_obj_set_style_text_color(obj,lv_color_hex(color),0);
    lv_obj_set_style_text_align(obj,LV_TEXT_ALIGN_CENTER,0);
    lv_label_set_long_mode(obj,LV_LABEL_LONG_CLIP); lv_label_set_text(obj,text);
    return obj;
}
void clicked(lv_event_t *event) {
    // Defer actions until input dispatch ends; never delete a pressed widget.
    if (pending==NONE) pending=static_cast<Action>(reinterpret_cast<uintptr_t>(lv_event_get_user_data(event)));
}
lv_obj_t *button(const char *text,int x,int y,int w,int h,Action action,
                 bool primary=false,const lv_font_t *font=nullptr) {
    auto obj=lv_button_create(desktop);
    lv_obj_set_pos(obj,x,y); lv_obj_set_size(obj,w,h);
    lv_obj_set_style_bg_color(obj,lv_color_hex(primary?0x239B78:0xDFF0E8),0);
    lv_obj_set_style_radius(obj,20,0); lv_obj_set_style_shadow_width(obj,0,0);
    lv_obj_set_style_pad_all(obj,0,0);
    auto text_obj=lv_label_create(obj);
    lv_obj_set_style_text_font(text_obj,font?font:title_font,0);
    lv_obj_set_style_text_color(text_obj,lv_color_hex(primary?0xFFFFFF:GREEN),0);
    lv_label_set_text(text_obj,text); lv_obj_center(text_obj);
    lv_obj_add_event_cb(obj,clicked,action==UNLOCK?LV_EVENT_LONG_PRESSED:LV_EVENT_CLICKED,
        reinterpret_cast<void *>(static_cast<uintptr_t>(action)));
    return obj;
}
void back() { button("返回",100,382,190,60,BACK); }
void read_calendar() {
    time_t china=time(nullptr)+8*3600;
    if (china<1735689600) { calendar=watch::Calendar{}; return; }
    struct tm date; gmtime_r(&china,&date);
    calendar={date.tm_year+1900,date.tm_mon+1,date.tm_mday,date.tm_hour,date.tm_min};
}
bool set_brightness(int percent) {
    int fd=open("/dev/lcd0",O_RDWR);
    if (fd<0) return false;
    int raw=(percent*CONFIG_LCD_MAXCONTRAST+50)/100;
    int result=ioctl(fd,LCDDEVIO_SETCONTRAST,static_cast<unsigned long>(raw));
    int readback=-1;
    if (result==0) result=ioctl(fd,LCDDEVIO_GETCONTRAST,reinterpret_cast<unsigned long>(&readback));
    close(fd);
    printf("VMC_DESKTOP brightness percent=%d raw=%d readback=%d result=%d\n",percent,raw,readback,result);
    return result==0 && readback==raw;
}
void refresh() {
    char text[96]; uint64_t now=monotonic_ms();
    if (page==MAIN || page==LOCK) {
        time_t utc=time(nullptr);
        if (last_value==static_cast<uint64_t>(utc/60)) return;
        last_value=utc/60;
        if (utc<1735689600) {
            lv_label_set_text(value_label,"--:--"); lv_label_set_text(detail_label,"请在设置中校时");
        } else {
            time_t china=utc+8*3600; struct tm date; gmtime_r(&china,&date);
            snprintf(text,sizeof(text),"%02d:%02d",date.tm_hour,date.tm_min);
            lv_label_set_text(value_label,text);
            const char *days[]={"周日","周一","周二","周三","周四","周五","周六"};
            snprintf(text,sizeof(text),"%02d月%02d日  %s",date.tm_mon+1,date.tm_mday,days[date.tm_wday]);
            lv_label_set_text(detail_label,text);
        }
    } else if (page==STOPWATCH || page==COUNTDOWN) {
        uint64_t seconds=page==STOPWATCH?stopwatch.elapsed(now)/1000:(countdown.left(now)+999)/1000;
        if (seconds==last_value) return;
        last_value=seconds;
        if (page==STOPWATCH) snprintf(text,sizeof(text),"%02lu:%02lu:%02lu",
            static_cast<unsigned long>((seconds/3600)%100),static_cast<unsigned long>(seconds/60%60),static_cast<unsigned long>(seconds%60));
        else snprintf(text,sizeof(text),"%02lu:%02lu",static_cast<unsigned long>(seconds/60),static_cast<unsigned long>(seconds%60));
        lv_label_set_text(value_label,text);
    } else if (page==CLOCK) {
        const char *names[]={"年份","月份","日期","小时","分钟"};
        int values[]={calendar.year,calendar.month,calendar.day,calendar.hour,calendar.minute};
        snprintf(text,sizeof(text),"%s  %02d",names[field],values[field]); lv_label_set_text(value_label,text);
        snprintf(text,sizeof(text),"%04d-%02d-%02d  %02d:%02d",calendar.year,calendar.month,calendar.day,calendar.hour,calendar.minute);
        lv_label_set_text(detail_label,text);
        lv_label_set_text(state_label,clock_error?"校时失败，请重试":"北京时间 · 点字段切换");
    } else if (page==SETTINGS) {
        snprintf(text,sizeof(text),"亮度  %d%%",brightness); lv_label_set_text(value_label,text);
        lv_label_set_text(state_label,brightness_error?"调节失败，请重试":"重启后亮度恢复 80%");
    }
}
class DesktopObserver : public shell::ShellApp::Observer {
    void onNotifyEvent(shell::ShellApp *,int event,void *) override {
        // The async JS runtime may call this observer from its own thread.
        // Only the GUI timer reads page state or changes LVGL objects.
        if (event==QAPP_EVENT_REQ_EXIT) app_return_requested.store(true);
    }
};
void open_app() {
    if (page==APP) return;
    if (!app_screen) app_screen=lv_obj_create(nullptr);
    lv_screen_load(app_screen); page=APP;
    if (!running_app) {
        running_app=shell::ShellApp::Create(app_uri.c_str(),message_loop,
            std::make_unique<shell::ShellApp::Delegate>(),false);
        running_app->addObserver(std::make_unique<DesktopObserver>());
        running_app->setUILoop(uv_loop); running_app->create((NativeWidgetHandle)app_screen);
        printf("VMC_DESKTOP launch\n");
    } else { running_app->show(); printf("VMC_DESKTOP resume\n"); }
    lv_obj_remove_flag(home_button,LV_OBJ_FLAG_HIDDEN);
}
void show(Page next) {
    if (next==APP) { open_app(); return; }
    if (page==APP && running_app) { running_app->hide(); printf("VMC_DESKTOP home app_preserved=1\n"); }
    lv_obj_add_flag(home_button,LV_OBJ_FLAG_HIDDEN);
    lv_screen_load(desktop); page=next; lv_obj_clean(desktop); last_value=UINT64_MAX;
    value_label=detail_label=state_label=nullptr;
    const char *titles[]={"手表桌面","实用工具","秒表","倒计时","快捷设置","设置时间","系统信息","已锁屏","时间到"};
    label(titles[page],24,46,title_font);
    if (page==MAIN) {
        value_label=label("--:--",82,94,large_font,GREEN); detail_label=label("",177,38,small_font);
        button("工具",39,233,150,60,TOOLS_GO); button("设置",201,233,150,60,SETTINGS_GO);
        button(running_app?"返回小芽":"小芽运动",39,303,312,78,OPEN,true);
        button("锁屏",100,389,190,54,LOCK_GO,false,small_font);
    } else if (page==TOOLS) {
        button("秒表",39,88,312,74,STOPWATCH_GO,true);
        button("倒计时",39,176,312,74,COUNTDOWN_GO);
        button("系统信息",39,264,312,74,ABOUT_GO); back();
    } else if (page==STOPWATCH) {
        value_label=label("00:00:00",106,84,timer_font,GREEN);
        label(stopwatch.running?"计时中 · 离开仍继续":"已暂停",207,42,small_font);
        button(stopwatch.running?"暂停":"开始",39,276,150,74,SW_TOGGLE,true);
        button("归零",201,276,150,74,SW_RESET); back();
    } else if (page==COUNTDOWN) {
        value_label=label("01:00",83,94,large_font,GREEN);
        label(countdown.running?"计时中 · 离开仍提醒":"到时屏幕提醒",178,38,small_font);
        auto minus=button("−1分",39,224,150,60,CD_MINUS);
        auto plus=button("+1分",201,224,150,60,CD_PLUS);
        if (countdown.running) { lv_obj_add_state(minus,LV_STATE_DISABLED); lv_obj_add_state(plus,LV_STATE_DISABLED); }
        button(countdown.running?"暂停":"开始",39,300,150,68,CD_TOGGLE,true);
        button("复位",201,300,150,68,CD_RESET); back();
    } else if (page==SETTINGS) {
        value_label=label("",85,48,title_font);
        button("调暗",39,143,150,66,DIM); button("调亮",201,143,150,66,BRIGHT);
        state_label=label("",219,38,small_font);
        button("设置时间",39,279,312,74,CLOCK_GO,true); back();
    } else if (page==CLOCK) {
        detail_label=label("",84,40,small_font);
        auto field_button=button("",39,137,312,64,FIELD); value_label=lv_obj_get_child(field_button,0);
        button("−",39,216,150,60,MINUS); button("+",201,216,150,60,PLUS);
        state_label=label("",281,38,small_font);
        button("保存时间",100,321,190,58,SAVE,true,small_font); back();
    } else if (page==ABOUT) {
        label("黄山派 SF32LB52",91,46,title_font); label("openvela / NuttX",151,42,small_font);
        label("自定义桌面 v2",202,42,small_font); label("390 × 450 · 大字触控",253,42,small_font);
        label("时间与计时重启后重设",312,40,small_font); back();
    } else if (page==LOCK) {
        value_label=label("--:--",113,94,large_font,GREEN); detail_label=label("",221,42,small_font);
        label("防误触 · 不会停止计时",282,42,small_font);
        button("长按解锁",88,349,214,74,UNLOCK,true);
    } else if (page==ALERT) {
        label("倒计时结束",117,60,title_font,GREEN); label("请留意当前事项",203,42,small_font);
        button("知道了",79,294,232,78,ACK,true);
    }
    refresh(); printf("VMC_DESKTOP page=%d\n",page);
}
void tick(lv_timer_t *) {
    if (app_return_requested.exchange(false) && page==APP) pending=HOME;
    Action action=pending; pending=NONE; uint64_t now=monotonic_ms();
    switch (action) {
    case OPEN: open_app(); break;
    case HOME: show(MAIN); break;
    case TOOLS_GO: show(TOOLS); break;
    case STOPWATCH_GO: show(STOPWATCH); break;
    case COUNTDOWN_GO: show(COUNTDOWN); break;
    case SETTINGS_GO: show(SETTINGS); break;
    case CLOCK_GO: read_calendar(); field=0; clock_error=false; show(CLOCK); break;
    case ABOUT_GO: show(ABOUT); break;
    case LOCK_GO: show(LOCK); break;
    case UNLOCK: show(MAIN); break;
    case BACK: show(page==CLOCK?SETTINGS:page==STOPWATCH||page==COUNTDOWN||page==ABOUT?TOOLS:MAIN); break;
    case SW_TOGGLE: stopwatch.toggle(now); show(STOPWATCH); break;
    case SW_RESET: stopwatch.reset(); show(STOPWATCH); break;
    case CD_TOGGLE: countdown.toggle(now); show(COUNTDOWN); break;
    case CD_RESET: countdown.reset(); show(COUNTDOWN); break;
    case CD_MINUS: countdown.adjust(-60); last_value=UINT64_MAX; break;
    case CD_PLUS: countdown.adjust(60); last_value=UINT64_MAX; break;
    case DIM: case BRIGHT: {
        int target=brightness+(action==DIM?-20:20);
        if (target>=20 && target<=100) { brightness_error=!set_brightness(target); if (!brightness_error) brightness=target; }
        break;
    }
    case FIELD: field=(field+1)%5; break;
    case MINUS: case PLUS: calendar.adjust(field,action==MINUS?-1:1); break;
    case SAVE: {
        struct tm date={}; date.tm_year=calendar.year-1900; date.tm_mon=calendar.month-1;
        date.tm_mday=calendar.day; date.tm_hour=calendar.hour; date.tm_min=calendar.minute;
        struct timespec ts={timegm(&date)-8*3600,0}; clock_error=clock_settime(CLOCK_REALTIME,&ts)!=0;
        printf("VMC_DESKTOP clock_save success=%d epoch=%ld\n",!clock_error,static_cast<long>(ts.tv_sec));
        if (!clock_error) show(MAIN); break;
    }
    case ACK: show(alert_return); break;
    default: break;
    }
    if (countdown.expire(now)) { alert_return=page; show(ALERT); printf("VMC_DESKTOP countdown_expired return=%d\n",alert_return); }
    if (action!=NONE || page==MAIN || page==LOCK || page==STOPWATCH || page==COUNTDOWN) refresh();
}
}
extern "C" bool watch_desktop_init(MessageLoop *messages,uv_loop_t *loop,const char *uri) {
    message_loop=messages; uv_loop=loop; app_uri=uri;
    const char *font="/etc/data/font/MiSans-Regular.ttf";
    large_font=lv_freetype_font_create(font,LV_FREETYPE_FONT_RENDER_MODE_BITMAP,76,LV_FREETYPE_FONT_STYLE_NORMAL);
    timer_font=lv_freetype_font_create(font,LV_FREETYPE_FONT_RENDER_MODE_BITMAP,60,LV_FREETYPE_FONT_STYLE_NORMAL);
    title_font=lv_freetype_font_create(font,LV_FREETYPE_FONT_RENDER_MODE_BITMAP,34,LV_FREETYPE_FONT_STYLE_NORMAL);
    small_font=lv_freetype_font_create(font,LV_FREETYPE_FONT_RENDER_MODE_BITMAP,26,LV_FREETYPE_FONT_STYLE_NORMAL);
    if (!large_font || !timer_font || !title_font || !small_font) return false;
    desktop=lv_screen_active(); lv_obj_set_style_bg_color(desktop,lv_color_hex(BG),0);
    lv_obj_set_style_bg_opa(desktop,LV_OPA_COVER,0); lv_obj_remove_flag(desktop,LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_add_event_cb(desktop,[](lv_event_t *) {
        if (pending!=NONE || page==LOCK || page==ALERT) return;
        auto direction=lv_indev_get_gesture_dir(lv_indev_active());
        if (direction==LV_DIR_RIGHT && page!=MAIN) pending=BACK;
        else if (direction==LV_DIR_LEFT && page==MAIN) pending=TOOLS_GO;
    },LV_EVENT_GESTURE,nullptr);
    home_button=lv_button_create(lv_layer_top()); lv_obj_set_pos(home_button,68,377); lv_obj_set_size(home_button,117,59);
    lv_obj_set_style_bg_color(home_button,lv_color_hex(0xDFF6EE),0);
    lv_obj_set_style_radius(home_button,20,0); lv_obj_set_style_shadow_width(home_button,0,0);
    auto home_text=lv_label_create(home_button); lv_obj_set_style_text_font(home_text,title_font,0);
    lv_obj_set_style_text_color(home_text,lv_color_hex(GREEN),0); lv_label_set_text(home_text,"桌面"); lv_obj_center(home_text);
    lv_obj_add_event_cb(home_button,clicked,LV_EVENT_CLICKED,reinterpret_cast<void *>(HOME));
    brightness_error=!set_brightness(brightness);
    show(MAIN); lv_timer_create(tick,20,nullptr); printf("VMC_DESKTOP ready tools=v2\n"); return true;
}
