"""Restore the verified official source archives into the D-backed Linux disk."""
from pathlib import Path, PurePosixPath
import json
import shutil
import tarfile
import zipfile

cached = Path('/mnt/c/Users/24470/.codex/visualizations/2026/09/20/01a0bdd9-97b8-7931-8986-190cb9fdc268/openvela-work')
root = Path('/opt/openvela')
src = root / 'src'
src.mkdir(parents=True, exist_ok=True)
def untar(archive, destination):
    destination.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive) as tf:
        for member in tf:
            parts = PurePosixPath(member.name).parts[1:]
            if not parts:
                continue
            member.name = str(PurePosixPath(*parts))
            path = destination / member.name
            target = path.parent / member.linkname if member.issym() else path
            if not target.resolve().is_relative_to(src.resolve()):
                raise ValueError(f'Archive entry escapes source workspace: {member.name}')
            tf.extract(member, destination, filter='tar')

def unzip(archive, destination):
    with zipfile.ZipFile(archive) as zf:
        for member in zf.infolist():
            parts = PurePosixPath(member.filename).parts[1:]
            if not parts or '..' in parts:
                continue
            path = destination.joinpath(*parts)
            if member.is_dir():
                path.mkdir(parents=True, exist_ok=True)
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(member) as data, path.open('wb') as out:
                    shutil.copyfileobj(data, out)

untar(cached/'nuttx.tar.gz',src/'nuttx')
items=[json.loads(p.read_text()) for p in (cached/'downloads').glob('*.json')]
for item in sorted(items,key=lambda x:len(PurePosixPath(x['path']).parts)):
    untar(cached/'downloads'/(item['name']+'.tar.gz'),src/item['path'])
    print(item['name'],flush=True)
unzip(cached/'vendor_sifli.zip',src/'vendor/sifli')
unzip(cached/'libs_sifli_sf32lb52.zip',src/'vendor/sifli/boards/sf32lb52/libs')
for name in ['external','frameworks','packages']:
    link=src/'apps'/name
    if not link.exists():
        link.symlink_to('../'+name,target_is_directory=True)
jidl=src/'prebuilts/tools/rust/bin/jidl/jidl_gen_cpp'
jidl.parent.mkdir(parents=True,exist_ok=True)
shutil.copy2(cached/'metadata/tools-rust-bin-jidl-jidl_gen_cpp',jidl)
jidl.chmod(0o755)
print('Source tree and official Linux JIDL generator ready.',flush=True)
