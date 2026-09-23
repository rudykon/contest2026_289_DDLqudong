"""Download the public Git LFS object through GitHub's official batch API."""
import hashlib
from pathlib import Path
import requests

oid='a195aa82de249920444adf2a8c6fcfeacffc82b4521ffb3496bda8c379a14f82'
size=124984128
target=Path(r'D:\wsl_ubuntu\setup\libgui_wrapper.a')
response=requests.post('https://github.com/open-vela/libs_sifli_sf32lb52.git/info/lfs/objects/batch',
    json={'operation':'download','transfers':['basic'],'objects':[{'oid':oid,'size':size}]},
    headers={'Accept':'application/vnd.git-lfs+json','Content-Type':'application/vnd.git-lfs+json'},timeout=(20,60))
if response.status_code != 200:
    raise RuntimeError(f'LFS metadata request failed: HTTP {response.status_code}')
obj=response.json()['objects'][0]
if 'error' in obj:
    raise RuntimeError(f'LFS object not available: {obj["error"].get("code")}')
action=obj['actions']['download']
with requests.get(action['href'],headers=action.get('header',{}),stream=True,timeout=(20,90)) as download:
    if download.status_code != 200:
        raise RuntimeError(f'LFS download failed: HTTP {download.status_code}')
    digest=hashlib.sha256()
    count=0
    with target.open('wb') as out:
        for block in download.iter_content(1024*1024):
            out.write(block)
            digest.update(block)
            count+=len(block)
    if count != size or digest.hexdigest() != oid:
        raise RuntimeError('LFS object length or SHA256 mismatch')
print(f'Verified {target.name}: {count} bytes, SHA256 {oid}')
