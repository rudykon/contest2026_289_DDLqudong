"""Subset shared watch fonts; preserve all current text and common Chinese.

Run in the D-drive WSL venv with fonttools==4.65.0. Full originals are kept
outside ROMFS. The selected glyph outlines, metrics and hints must match.
"""
from pathlib import Path
import hashlib, json, re, shutil, zipfile
import fontTools
from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.pens.recordingPen import RecordingPen

support = Path(__file__).resolve().parent
project = support.parent.parent
romfs = Path('/opt/openvela/src/vendor/sifli/boards/sf32lb52/lckfb_huangshan_pi/src/etc')
originals = Path('/opt/openvela/font-originals')
originals.mkdir(parents=True, exist_ok=True)
known = {
    'MiSans-Regular.ttf':'1de0e469323439969b12bb531a41795ae6f8396687e262ca5329554874a3a2b0',
    'MiSans-Demibold.ttf':'edf14b2d7e3f7a26cd694486015a2c6d1de4e688ba19f663e88212406a1c3c2c',
}
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def cjk(cp): return 0x3400 <= cp <= 0x9fff or 0xf900 <= cp <= 0xfaff or 0x20000 <= cp <= 0x323af

texts = [p.read_text(encoding='utf-8') for p in (project/'quickapp/velamotion_coach/src').rglob('*')
         if p.is_file() and p.suffix in ('.ux','.js','.json')]
texts += [(support/name).read_text(encoding='utf-8') for name in ['watch_desktop.cpp','watch_tools.h']]
texts += [p.read_text(encoding='utf-8') for p in (romfs/'data/app/com.velamotion.coach').rglob('*')
          if p.is_file() and p.suffix in ('.js','.json')]
rpk = project/'quickapp/velamotion_coach/dist/com.velamotion.coach.huangshan-dev.1.0.0.rpk'
with zipfile.ZipFile(rpk) as archive:
    texts += [archive.read(name).decode('utf-8') for name in archive.namelist() if name.endswith(('.js','.json'))]
required = {ord(c) for text in texts for c in text}
required |= {int(code,16) for text in texts for code in re.findall(r'\\u([0-9a-fA-F]{4})',text)}
required = {cp for cp in required if cp >= 32 and not 0xd800 <= cp <= 0xdfff}
# GB2312 level-one rows provide a deterministic common-character reserve.
common = set()
for high in range(0xb0,0xd8):
    for low in range(0xa1,0xff):
        try: common.add(ord(bytes([high,low]).decode('gb2312')))
        except UnicodeDecodeError: pass
assert len(common)==3755
report = {'fonttools':fontTools.__version__, 'common_chinese_count':len(common),
          'source_codepoints':len(required), 'source_cjk_count':sum(cjk(cp) for cp in required),
          'rpk_sha256':sha(rpk), 'fonts':[]}
for filename,expected in known.items():
    destination=romfs/'data/font'/filename
    original=originals/filename
    if not original.exists():
        toolkit = Path('/mnt/d/wsl_ubuntu/app-work/velamotion_coach/node_modules/@aiot-toolkit/velasim/font')
        candidates = [destination, toolkit/filename.replace('MiSans-','MiSansW_')]
        source = next((p for p in candidates if p.exists() and sha(p)==expected),None)
        if source is None: raise RuntimeError('Complete original font unavailable: '+filename)
        shutil.copy2(source,original)
    assert sha(original)==expected, 'Original font changed: '+filename
    font=TTFont(original,recalcTimestamp=False)
    cmap=font.getBestCmap()
    assert common <= set(cmap), 'Original font lacks common Chinese reserve'
    assert required <= set(cmap), 'New source text needs font coverage: ' + filename
    weight=font['OS/2'].usWeightClass
    # Keep every original non-CJK character (Latin, numbers, units, punctuation,
    # symbols) plus all source Chinese and the common-character reserve.
    keep={cp for cp in cmap if not cjk(cp) or cp in required or cp in common}
    options=subset.Options()
    options.hinting=True
    options.glyph_names=True
    options.notdef_outline=True
    options.name_IDs=['*']
    options.name_languages=['*']
    options.layout_features=['*']
    options.recalc_timestamp=False
    subsetter=subset.Subsetter(options=options)
    subsetter.populate(unicodes=keep)
    subsetter.subset(font)
    temporary=destination.with_suffix('.subset.tmp')
    font.save(temporary)
    old=TTFont(original,recalcTimestamp=False)
    new=TTFont(temporary,recalcTimestamp=False)
    after=new.getBestCmap()
    assert keep <= set(after), 'Subset lost selected characters'
    assert not (required & set(cmap) - set(after)), 'Subset lost existing source text'
    for table,attrs in {'head':['unitsPerEm'],'hhea':['ascent','descent','lineGap'],
                        'OS/2':['usWeightClass','fsSelection','sTypoAscender','sTypoDescender',
                                'sTypoLineGap','usWinAscent','usWinDescent']}.items():
        for attr in attrs: assert getattr(old[table],attr)==getattr(new[table],attr),(filename,table,attr)
    old_glyphs,new_glyphs=old.getGlyphSet(),new.getGlyphSet()
    checked=set()
    for cp in keep:
        before_name,after_name=cmap[cp],after[cp]
        assert old['hmtx'][before_name]==new['hmtx'][after_name], ('advance',cp)
        if before_name in checked: continue
        checked.add(before_name)
        a,b=RecordingPen(),RecordingPen()
        old_glyphs[before_name].draw(a); new_glyphs[after_name].draw(b)
        assert a.value==b.value, ('outline',cp)
        a_hint=getattr(old['glyf'][before_name],'program',None)
        b_hint=getattr(new['glyf'][after_name],'program',None)
        assert (a_hint.getBytecode() if a_hint else b'')==(b_hint.getBytecode() if b_hint else b''),('hinting',cp)
    old.close();new.close();font.close()
    result={'name':filename,'before_bytes':original.stat().st_size,'after_bytes':temporary.stat().st_size,
            'before_codepoints':len(cmap),'after_codepoints':len(after),'verified_glyphs':len(checked),
            'weight_class':weight, 'common_chinese_preserved':len(common),
            'source_supported_before':len(required & set(cmap)), 'newly_missing_source_codepoints':[],
            'already_unsupported_source_codepoints':[f'U+{cp:04X}' for cp in sorted(required-set(cmap))],
            'outline_metrics_hinting_equal':True,'original_sha256':expected,'subset_sha256':sha(temporary)}
    if destination.exists() and sha(destination)==sha(temporary): temporary.unlink()
    else: temporary.replace(destination)
    report['fonts'].append(result)
    print(filename,result['before_bytes'],'->',result['after_bytes'],'bytes;',len(after),'codepoints')
(support/'validation/font-subset-coverage.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
(support/'validation/font-subset-required-characters.txt').write_text(''.join(chr(cp) for cp in sorted(required)),encoding='utf-8')
