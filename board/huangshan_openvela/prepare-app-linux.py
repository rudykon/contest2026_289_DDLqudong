"""Install the built app into this board's ROMFS and configure its runtime."""
from pathlib import Path
import hashlib
import zipfile
import sys
import shutil
import subprocess

support = Path(__file__).resolve().parent

def write_changed(path, content):
    if not path.exists() or path.read_text() != content:
        path.write_text(content)

root = Path('/opt/openvela/src')
board = root / 'vendor/sifli/boards/sf32lb52/lckfb_huangshan_pi'
rpk = Path('/mnt/d/wsl_ubuntu/app-work/velamotion_coach/dist/com.velamotion.coach.release.1.0.0.rpk')
destination = board / 'src/etc/data/app/com.velamotion.coach'
destination.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(rpk) as archive:
    for member in archive.infolist():
        target = (destination / member.filename).resolve()
        if not target.is_relative_to(destination.resolve()):
            raise ValueError('Unsafe archive entry: ' + member.filename)
    archive.extractall(destination)
assert (destination / 'manifest.json').exists()
subprocess.run([sys.executable, str(support / 'prepare-runtime-latency-linux.py')], check=True)
if '--assets-only' in sys.argv:
    subprocess.run([sys.executable, str(support / 'subset-fonts-linux.py')], check=True)
    print('RPK SHA256:', hashlib.sha256(rpk.read_bytes()).hexdigest())
    raise SystemExit(0)

config = board / 'configs/nsh/defconfig'
backup = config.with_suffix('.official')
if not backup.exists():
    backup.write_bytes(config.read_bytes())
settings = {
    # Curl uses native socketpair for the image cache's internal wakeup channel.
    # Without this, the official config hangs inside TCP accept at GUI startup.
    'CONFIG_NET_LOCAL': 'y',
    'CONFIG_NET_LOCAL_STREAM': 'y',
    'CONFIG_KVDB_SERVER': 'y',
    'CONFIG_KVDB_FILE': 'y',
    'CONFIG_KVDB_TEMPORARY_STORAGE': 'y',
    'CONFIG_KVDB_PERSIST_PATH': '"/data/properties"',
    'CONFIG_KVDB_TEMPORARY_PATH': '"/data/kv-runtime"',
    'CONFIG_KVDB_STACKSIZE': '8192',
    'CONFIG_QUICKAPP_JSHEAPSIZE': '3145728',
    'CONFIG_EXAMPLES_LVGLDEMO': 'n',
    'CONFIG_LV_USE_DEMO_WIDGETS': 'n',
    'CONFIG_LV_FONT_MONTSERRAT_16': 'n',
    'CONFIG_LV_FONT_MONTSERRAT_20': 'n',
    'CONFIG_LV_FONT_MONTSERRAT_24': 'n',
    'CONFIG_LV_FONT_MONTSERRAT_28': 'n',
    'CONFIG_LV_FONT_MONTSERRAT_48': 'n',
}
lines = config.read_text().splitlines()
lines = [line for line in lines if not any(
    line.startswith(key + '=') or line == '# ' + key + ' is not set'
    for key in settings)]
lines.extend('# ' + key + ' is not set' if value == 'n' else key + '=' + value
             for key, value in settings.items())
write_changed(config, '\n'.join(lines) + '\n')
# This runtime resolves manifest/code relative to BaseDataDir as well. Seed
# the writable RAM copy from ROMFS on every boot; do not imply persistence.
boot = ['mkdir /data/properties', 'mkdir /data/quickapp',
        'mkdir /data/quickapp/com.velamotion.coach',
        'cd /data/quickapp/com.velamotion.coach']
for directory in sorted((p for p in destination.rglob('*') if p.is_dir()),
                        key=lambda p: (len(p.parts), str(p))):
    boot.append('mkdir ' + directory.relative_to(destination).as_posix())
for file in sorted(p for p in destination.rglob('*') if p.is_file()):
    relative = file.relative_to(destination)
    boot.append('cd /data/quickapp/com.velamotion.coach')
    if str(relative.parent) != '.':
        boot.append('cd ' + relative.parent.as_posix())
    boot.append('cp /etc/data/app/com.velamotion.coach/' + relative.as_posix() + ' .')
# RCSRCS goes through the C preprocessor; quote the URI so // is not a comment.
boot += ['cd /', 'kvdbd &', 'sleep 3', 'vapp "hap://app/com.velamotion.coach" &']
assert all(len(command) < 64 for command in boot), 'NSH line too long'
write_changed(board / 'src/etc/init.d/rcS', '\n'.join(boot) + '\n')
write_changed(board / 'src/etc/build.prop',
    'ro.product.brand=LCKFB\n'
    'ro.product.model=lckfb_huangshan_pi\n'
    'ro.product.marketname=Huangshan Pi SF32LB52\n'
    'ro.product.manufacturer=LCKFB\n'
    'ro.product.device.devicetype=watch\n'
    'ro.product.device.screenshape=rect\n'
    'ro.system.language=zh\n'
    'ro.system.region=CN\n'
    'ro.system.osversioncode=1000\n')
cmake = board / 'src/CMakeLists.txt'
cmake_text = cmake.read_text()
old_resources = 'file(GLOB_RECURSE _HAP_ABS ${CMAKE_CURRENT_LIST_DIR}/etc/data/app/* ${CMAKE_CURRENT_LIST_DIR}/etc/data/font/*)'
new_resources = ('# Only ship this product app; retain upstream examples in the source tree.\n'
                 'file(GLOB_RECURSE _HAP_ABS ${CMAKE_CURRENT_LIST_DIR}/etc/data/app/com.velamotion.coach/* ${CMAKE_CURRENT_LIST_DIR}/etc/data/font/*)')
if old_resources in cmake_text:
    cmake_text = cmake_text.replace(old_resources, new_resources)
elif new_resources not in cmake_text:
    raise RuntimeError('Unexpected board ROMFS resource definition')
# nuttx_add_romfs copies PATH wholesale. Use its generated RCRAWS/RCSRCS tree,
# not the original source tree that deliberately retains upstream examples.
old_path = '  PATH\n  ${CMAKE_CURRENT_LIST_DIR}/etc)'
new_path = '  PATH\n  ${CMAKE_CURRENT_BINARY_DIR}/etc)'
if old_path in cmake_text:
    cmake_text = cmake_text.replace(old_path, new_path)
elif new_path not in cmake_text:
    raise RuntimeError('Unexpected board ROMFS staging path')
build_root = Path('/opt/openvela/build').resolve()
for stage in ['etc', 'romfs_etc']:
    for example in ['com.calculator.vela', 'com.application.lyra.demo']:
        generated = build_root / 'boards/exclude_board/src' / stage / 'data/app' / example
        if generated.exists():
            if not generated.resolve().is_relative_to(build_root):
                raise RuntimeError('Unsafe generated resource path: ' + str(generated))
            shutil.rmtree(generated)
if '  etc/build.prop\n' not in cmake_text:
    cmake_text = cmake_text.replace('  etc/group\n', '  etc/group\n  etc/build.prop\n')
write_changed(cmake, cmake_text)
# The official vapp wrapper puts mutable app data beside code in /etc (ROMFS).
# Keep code in ROMFS and give feature.storage a writable, volatile data path.
wrapper = root / 'frameworks/runtimes/quickapp/shell/vapp/qwrapper.cpp'
wrapper_text = wrapper.read_text()
write_changed(wrapper, wrapper_text.replace(
    'auto app_path = get_app_path() / package_name;',
    'auto app_path = fs::path("/data/quickapp") / package_name;'))
support = Path(__file__).resolve().parent
exec(compile((support / 'prepare-brightness-linux.py').read_text(),
             str(support / 'prepare-brightness-linux.py'), 'exec'))
shutil.copy2(support / 'quickapp_limits.c', board / 'src/quickapp_limits.c')
cmake_text = cmake.read_text()
if 'list(FILTER QUICKAPP_LIBS EXCLUDE' not in cmake_text:
    cmake_text = cmake_text.replace('  if(QUICKAPP_LIBS)',
        '  # Build the application shell from source, including board fixes.\n'
        '  list(FILTER QUICKAPP_LIBS EXCLUDE REGEX "/libapps_vapp\\\\.a$")\n'
        '  if(QUICKAPP_LIBS)')
if 'quickapp_limits.c)' not in cmake_text:
    cmake_text += '\ntarget_sources(board PRIVATE quickapp_limits.c)\n'
    cmake_text += 'target_link_options(nuttx PRIVATE "LINKER:--wrap=JS_SetMemoryLimit")\n'
write_changed(cmake, cmake_text)
vapp = root / 'frameworks/runtimes/quickapp/shell/vapp'
shutil.copy2(support / 'vmc_probe.cpp', vapp / 'vmc_probe.cpp')
shutil.copy2(support / 'watch_desktop.cpp', vapp / 'watch_desktop.cpp')
shutil.copy2(support / 'watch_tools.h', vapp / 'watch_tools.h')
main = vapp / 'main.cpp'
if not main.with_suffix('.before-desktop.cpp').exists():
    main.with_suffix('.before-desktop.cpp').write_bytes(main.read_bytes())
write_changed(main, (support / 'vapp_desktop_main.cpp').read_text())
vapp_cmake = vapp / 'CMakeLists.txt'
vapp_text = vapp_cmake.read_text()
if 'vmc_probe.cpp' not in vapp_text:
    vapp_text = vapp_text.replace('${CMAKE_CURRENT_LIST_DIR}/main.cpp',
        '${CMAKE_CURRENT_LIST_DIR}/main.cpp\n    ${CMAKE_CURRENT_LIST_DIR}/vmc_probe.cpp')
if 'watch_desktop.cpp' not in vapp_text:
    vapp_text = vapp_text.replace('${CMAKE_CURRENT_LIST_DIR}/vmc_probe.cpp',
        '${CMAKE_CURRENT_LIST_DIR}/vmc_probe.cpp\n    ${CMAKE_CURRENT_LIST_DIR}/watch_desktop.cpp')
if 'target_include_directories(apps_vapp' not in vapp_text:
    vapp_text += '\nif(TARGET apps_vapp)\n  target_include_directories(apps_vapp PRIVATE ${NUTTX_APPS_DIR}/system/zlib/zlib)\nendif()\n'
write_changed(vapp_cmake, vapp_text)
subprocess.run([sys.executable, str(support / 'install-epic-linux.py')], check=True)
# Runtime feature data must not follow the read-only application code prefix.
for filename, macro in [('storage_impl.cpp', 'DB_PATH_PREFIX'),
                        ('app_path.cpp', 'ABS_PATH_PREFIX')]:
    feature = root / 'frameworks/runtimes/feature/modules' / filename
    write_changed(feature, feature.read_text().replace(
        '#define ' + macro + ' CONFIG_HAP_APP_PATH',
        '#define ' + macro + ' "/data/quickapp"'))
# Preserve both weights using validated subsets, never overwrite them with full fonts.
subprocess.run([sys.executable, str(support / 'subset-fonts-linux.py')], check=True)
print('ROMFS app:', destination)
print('RPK SHA256:', hashlib.sha256(rpk.read_bytes()).hexdigest())
