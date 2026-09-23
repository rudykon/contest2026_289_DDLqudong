"""Run WSL without corrupting its UTF-16 Windows diagnostics."""
import os
import subprocess
import sys

result = subprocess.run([os.path.join(os.environ['SystemRoot'], 'System32', 'wsl.exe'), *sys.argv[1:]], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
for raw, stream in [(result.stdout, sys.stdout), (result.stderr, sys.stderr)]:
    # WSL may prefix UTF-8 Linux stderr with a UTF-16 Windows warning.
    if b'\x00' in raw[:256]:
        split = raw.rfind(b'\x00') + 1
        message = raw[:split].decode('utf-16-le', errors='replace') + raw[split:].decode('utf-8', errors='replace')
    else:
        message = raw.decode('utf-8', errors='replace')
    print(message, end='', file=stream)
sys.exit(result.returncode)
