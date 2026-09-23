"""Read-only size audit of the final image and its retained linker sections."""
from pathlib import Path
from collections import defaultdict
import hashlib, json, re, subprocess

build = Path('/opt/openvela/build')
out = Path(__file__).resolve().parent / 'validation'
firmware = (build / 'nuttx.bin').read_bytes()
tree = build / 'boards/exclude_board/src/romfs_etc'
files = {str(p.relative_to(tree)): p.stat().st_size for p in tree.rglob('*') if p.is_file()}
groups = defaultdict(int)
for name, size in files.items():
    parts = name.split('/')
    group = '/'.join(parts[:3]) if name.startswith('data/app/') else '/'.join(parts[:2])
    groups[group] += size

# Linker string-merge entries can repeat and overlap. Exclude them rather than
# misrepresenting original input-section sizes as final flash consumption.
lines = (build / 'nuttx.map').read_text().split('Linker script and memory map',1)[1].splitlines()
pending = None
sections = []
for line in lines:
    match = re.match(r'^ (\.\S+)(?:\s+(0x[0-9a-f]+)\s+(0x[0-9a-f]+)\s+(.+))?$', line)
    if match:
        pending = match.group(1)
        if match.group(2): fields = match.groups()[1:]
        else: continue
    else:
        match = re.match(r'^\s+(0x[0-9a-f]+)\s+(0x[0-9a-f]+)\s+(.+)$',line)
        if not match or pending is None: continue
        fields = match.groups()
    section = pending; pending = None
    address, size, owner = int(fields[0],16), int(fields[1],16), fields[2]
    if not re.search(r'\.o\)?$', owner): continue
    if not size or not (0x12010000 <= address < 0x128f2748 or 0x20000000 <= address < 0x20023fe0): continue
    if not (section.startswith(('.text', '.rodata', '.data', '.ramfunc', '.l1_ret_text', '.ARM', '.vectors'))): continue
    if re.search(r'\.str\d+\.\d+', section): continue
    sections.append({'section': section, 'address':address, 'bytes':size, 'owner':owner})
archives=defaultdict(int)
objects=defaultdict(int)
for item in sections:
    archives[item['owner'].split('(')[0]] += item['bytes']
    objects[item['owner']] += item['bytes']
romfs_size = (build / 'boards/exclude_board/src/romfs.img').stat().st_size
report = {
    'firmware_bytes':len(firmware), 'firmware_sha256':hashlib.sha256(firmware).hexdigest(),
    'romfs_image_bytes':romfs_size, 'romfs_payload_bytes':sum(files.values()),
    'romfs_metadata_padding_bytes':romfs_size-sum(files.values()),
    'romfs_groups':dict(sorted(groups.items(),key=lambda v:-v[1])),
    'romfs_files':dict(sorted(files.items(),key=lambda v:-v[1])),
    'outside_romfs_bytes':len(firmware)-romfs_size,
    'retained_section_method':'Input sections from final map; merged string sections excluded; library totals are approximate, not a full flash partition.',
    'retained_archives':dict(sorted(archives.items(),key=lambda v:-v[1])),
    'retained_objects_top':dict(sorted(objects.items(),key=lambda v:-v[1])[:50]),
    'optional_retained_sections':{
        'lvgl_demo_code_images':sum(size for owner,size in objects.items() if 'liblvgl.a(' in owner and any(x in owner for x in ['lv_demo_', 'img_demo_', 'img_clothes.', 'img_lvgl_logo.'])),
        'lvgl_montserrat_fonts':sum(size for owner,size in objects.items() if 'liblvgl.a(lv_font_montserrat_' in owner),
        'example_and_test_apps':sum(size for owner,size in archives.items() if owner.startswith(('apps/examples/','apps/testing/'))),
        'native_desktop':sum(size for owner,size in objects.items() if 'watch_desktop.cpp.o' in owner),
        'screenshot_probe':sum(size for owner,size in objects.items() if 'vmc_probe.cpp.o' in owner)
    },
    'section_sizes':subprocess.check_output(['arm-none-eabi-size','-A',str(build/'nuttx')],text=True)
}
(out / 'size-firmware.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps({k:v for k,v in report.items() if k not in ['section_sizes','romfs_files','retained_objects_top']},ensure_ascii=False,indent=2))
