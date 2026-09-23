"""Fail before flashing if a product resource or startup invariant regresses."""
from pathlib import Path
import hashlib,json,subprocess
support=Path(__file__).resolve().parent
build=Path('/opt/openvela/build')
tree=build/'boards/exclude_board/src/romfs_etc'
apps=sorted(p.name for p in (tree/'data/app').iterdir())
assert apps==['com.velamotion.coach'],apps
expected='vapp "hap://app/com.velamotion.coach" &'
assert (tree/'init.d/rcS').read_text().splitlines()[-1]==expected, 'Boot command was altered by preprocessing'
coverage=json.loads((support/'validation/font-subset-coverage.json').read_text())
for font in coverage['fonts']:
    assert hashlib.sha256((tree/'data/font'/font['name']).read_bytes()).hexdigest()==font['subset_sha256']
    assert not font['newly_missing_source_codepoints']
symbols=subprocess.check_output(['arm-none-eabi-nm',str(build/'nuttx')],text=True)
removed=['lv_demo_widgets','img_demo_widgets','img_clothes_map','img_lvgl_logo_map','lvgldemo_main']
for name in removed: assert name not in symbols,name
assert 'lv_font_montserrat_14' in symbols
binary=(build/'nuttx.bin').read_bytes()
result={'firmware_bytes':len(binary),'firmware_sha256':hashlib.sha256(binary).hexdigest(),
        'apps':apps,'startup_command':expected,'font_hashes_match':True,
        'demo_symbols_absent':removed,'default_font_preserved':True}
(support/'validation/font-subset-image-checks.json').write_text(json.dumps(result,indent=2))
print(json.dumps(result,indent=2))
