"""Decode an actual board LVGL snapshot returned by NSH hexdump."""
from pathlib import Path
import re
import struct
import sys
import zlib
from PIL import Image

source, output = map(Path, sys.argv[1:3])
data = bytearray()
for line in source.read_text(encoding='utf-8-sig').splitlines():
    if re.match(r'^[0-9a-fA-F]{4}: ', line):
        data.extend(bytes.fromhex(line[6:54]))
width, height, stride, expected = struct.unpack_from('<4I', data)
assert 1 <= width <= 1024 and 1 <= height <= 1024
raw = zlib.decompress(data[16:])
assert len(raw) == expected and stride >= width * 2 and len(raw) >= stride * height
rgb = bytearray(width * height * 3)
for y in range(height):
    for x in range(width):
        value = struct.unpack_from('<H', raw, y * stride + x * 2)[0]
        offset = (y * width + x) * 3
        rgb[offset:offset+3] = bytes(((value >> 11) * 255 // 31,
                                    ((value >> 5) & 63) * 255 // 63,
                                    (value & 31) * 255 // 31))
output.parent.mkdir(parents=True, exist_ok=True)
Image.frombytes('RGB', (width, height), bytes(rgb)).save(output)
print(f'{output}: {width}x{height}; decoded {len(data)} bytes; compressed checksum valid')
