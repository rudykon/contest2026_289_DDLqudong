"""Audit deployed RPK, source sections, and minified JS without changing them."""
from pathlib import Path
from collections import defaultdict
import hashlib,json,re,subprocess,zipfile
board=Path(__file__).resolve().parent
app=board.parent.parent/'quickapp/velamotion_coach'
rpk=app/'dist/com.velamotion.coach.huangshan-dev.1.0.0.rpk'
with zipfile.ZipFile(rpk) as archive:
    entries=[{'name':f.filename,'bytes':f.file_size,'compressed_bytes':f.compress_size} for f in archive.infolist()]
    code=archive.read('pages/index/index.js')
result=subprocess.run(['C:/Program Files/nodejs/node.exe',str(board/'analyze-bundle.cjs')],input=code,capture_output=True,check=True)
ux=(app/'src/pages/index/index.ux').read_text(encoding='utf-8')
sections={tag:len(re.search('<'+tag+r'[^>]*>([\s\S]*?)</'+tag+'>',ux).group(1).encode()) for tag in ['template','script','style']}
groups=defaultdict(int)
for file in (app/'src/common').rglob('*'):
    if file.is_file(): groups[str(file.relative_to(app/'src/common')).split('\\')[0].split('/')[0]]+=file.stat().st_size
report={'rpk_bytes':rpk.stat().st_size,'rpk_sha256':hashlib.sha256(rpk.read_bytes()).hexdigest(),
        'unpacked_bytes':sum(e['bytes'] for e in entries),
        'compressed_entries_bytes':sum(e['compressed_bytes'] for e in entries),
        'container_overhead_bytes':rpk.stat().st_size-sum(e['compressed_bytes'] for e in entries),
        'entries':sorted(entries,key=lambda v:-v['bytes']),
        'source_ux_sections':sections,'source_common_groups':dict(groups),
        'bundle_ast':json.loads(result.stdout)}
(board/'validation/size-quickapp.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(report,ensure_ascii=False,indent=2))
