"""Install the board-owned EPIC backend; does not alter the upstream HAL/LVGL."""
from pathlib import Path
import re

support = Path(__file__).resolve().parent
root = Path('/opt/openvela/src')
chip = root / 'vendor/sifli/chips/sf32lb52'
vapp = root / 'frameworks/runtimes/quickapp/shell/vapp'

def changed(path, content):
    if not path.exists() or path.read_text() != content:
        path.write_text(content)

def block(path, content):
    start, end = '# VMC_EPIC_BEGIN', '# VMC_EPIC_END'
    text = path.read_text()
    text = re.sub(re.escape(start) + r'.*?' + re.escape(end) + r'\n?', '', text, flags=re.S)
    changed(path, text.rstrip() + '\n\n' + start + '\n' + content + '\n' + end + '\n')

for name in ['vmc_epic_hw.c', 'vmc_epic_hw.h']:
    changed(chip / name, (support / name).read_text())
for name in ['vmc_epic_lvgl.cpp', 'vmc_epic_hw.h', 'vmc_probe.cpp', 'watch_desktop.cpp']:
    changed(vapp / name, (support / name).read_text())
changed(vapp / 'main.cpp', (support / 'vapp_desktop_main.cpp').read_text())
block(chip / 'CMakeLists.txt', 'target_sources(arch PRIVATE ${CMAKE_CURRENT_LIST_DIR}/vmc_epic_hw.c)')
block(vapp / 'CMakeLists.txt', '''if(TARGET apps_vapp)
  target_sources(apps_vapp PRIVATE ${CMAKE_CURRENT_LIST_DIR}/vmc_epic_lvgl.cpp)
  target_link_options(nuttx PRIVATE
    "LINKER:--wrap=lv_draw_sw_blend_color_to_rgb565"
    "LINKER:--wrap=lv_draw_sw_blend_image_to_rgb565")
endif()''')
print('Installed NuttX EPIC driver and LVGL RGB565 raster backend')
