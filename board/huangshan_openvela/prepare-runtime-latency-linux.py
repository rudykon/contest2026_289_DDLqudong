"""Keep storage diagnostics bounded on the GUI thread; retain async uv_db I/O."""
from pathlib import Path

path = Path('/opt/openvela/src/frameworks/runtimes/feature/modules/storage_impl.cpp')
text = path.read_text()
old = 'FEATURE_LOG_INFO("[STORAGE_SET] key=%s,value=%s", info->key, info->value);'
new = '''// VMC: serializing the entire payload to UART blocks GUI dispatch.
    FEATURE_LOG_INFO("[STORAGE_SET] key=%s,bytes=%u", info->key ? info->key : "",
        (unsigned)(info->value ? strlen(info->value) : 0));'''
if old in text:
    backup = path.with_suffix('.cpp.before-vmc-log')
    if not backup.exists():
        backup.write_text(text)
    path.write_text(text.replace(old, new, 1))
elif new not in text:
    raise RuntimeError('Storage implementation changed: review logging patch before rebuilding')
print('Storage payload logging replaced by key/length; async storage behavior unchanged')
