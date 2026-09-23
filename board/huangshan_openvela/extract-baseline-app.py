"""Recover the exact comparison app from our saved firmware's ROMFS."""
from pathlib import Path
import struct
import zipfile

root = Path(__file__).resolve().parent
data = (root / 'firmware/velamotion-before-performance.bin').read_bytes()
offsets = [i for i in range(len(data)) if data.startswith(b'-rom1fs-', i)]
base = next(i for i in offsets if data[i+16:i+20] == b'etc\0')
fs = data[base:base + struct.unpack_from('>I', data, base + 8)[0]]
files = {}
def walk(offset, prefix):
    seen = set()
    while offset and offset not in seen:
        seen.add(offset)
        link, spec, size, checksum = struct.unpack_from('>4I', fs, offset)
        end = fs.index(0, offset + 16)
        name = fs[offset+16:end].decode()
        kind = link & 7
        if name not in ('.', '..'):
            path = prefix + name
            assert '/' not in name and '\\' not in name
            if kind == 1:
                walk(spec, path + '/')
            elif kind == 2 and path.startswith('data/app/com.velamotion.coach/'):
                content = (end + 16) & ~15
                files[path.removeprefix('data/app/com.velamotion.coach/')] = fs[content:content+size]
        offset = link & ~15
walk(32, '')
assert 'manifest.json' in files, files.keys()
with zipfile.ZipFile(root / 'validation/perf-baseline-app.rpk', 'w', zipfile.ZIP_DEFLATED) as archive:
    for name, content in files.items():
        archive.writestr(name, content)
print('Recovered exact baseline app:', [(name, len(content)) for name, content in files.items()])
