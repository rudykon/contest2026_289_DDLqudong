"""Build exact pre-optimization app with the same native measurement probe."""
from pathlib import Path
import subprocess
import zipfile
import shutil

local = Path(__file__).resolve().parent
app = Path('/opt/openvela/src/vendor/sifli/boards/sf32lb52/lckfb_huangshan_pi/src/etc/data/app/com.velamotion.coach')
desktop = Path('/opt/openvela/src/frameworks/runtimes/quickapp/shell/vapp/watch_desktop.cpp')
saved = {path: path.read_bytes() for path in app.rglob('*') if path.is_file()}
desktop_saved = desktop.read_bytes()
try:
    with zipfile.ZipFile(local / 'validation/perf-baseline-app.rpk') as archive:
        for member in archive.infolist():
            target = (app / member.filename).resolve()
            assert target.is_relative_to(app.resolve())
            target.write_bytes(archive.read(member))
    desktop.write_bytes(desktop_saved.replace(
        b'now / 60 == last_clock / 60 && last_clock != 0', b'now == last_clock'))
    with open('/opt/openvela/logs/perf-baseline-v2-build.log', 'w') as log:
        subprocess.run(['cmake', '--build', '/opt/openvela/build', '-j6'], stdout=log, stderr=subprocess.STDOUT, check=True)
    shutil.copy2('/opt/openvela/build/nuttx.bin', '/mnt/d/wsl_ubuntu/setup/perf-baseline-v2.bin')
finally:
    for path, data in saved.items():
        path.write_bytes(data)
    desktop.write_bytes(desktop_saved)
print('Comparison built; optimized sources restored.')
