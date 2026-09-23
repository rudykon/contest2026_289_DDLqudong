"""Resolve the optional on-board PC sampler against its matching ELF."""
from pathlib import Path
import bisect
import collections
import json
import re
import subprocess
import sys

support = Path(__file__).resolve().parent
elf = Path('/opt/openvela/build/nuttx-cpu-profile.elf')
name = sys.argv[1]
log = (support / 'logs' / (name + '.log')).read_text(encoding='utf-8-sig')
symbols = []
for line in subprocess.check_output(['arm-none-eabi-nm', '-n', '-S', '-C', str(elf)], text=True).splitlines():
    match = re.match(r'([0-9a-f]+) ([0-9a-f]+) [tTwW] (.*)', line)
    if match:
        symbols.append((int(match[1], 16), int(match[2], 16), match[3]))
symbols.sort()
starts = [s[0] for s in symbols]
def resolve(pc):
    pos = bisect.bisect_right(starts, pc & ~1) - 1
    if pos >= 0 and pc < symbols[pos][0] + symbols[pos][1]:
        return symbols[pos][2]
    return hex(pc)

batches = []
for block in log.split('VMC_CPU started')[1:]:
    samples = [(int(pc, 16), int(lr, 16)) for pc, lr in re.findall(r'VMC_CPU pc=([0-9a-f]+) lr=([0-9a-f]+)', block)]
    pc_counts = collections.Counter(resolve(pc) for pc, _ in samples)
    lr_counts = collections.Counter(resolve(lr) for _, lr in samples)
    top = [{'function': function, 'samples': count, 'percent': round(count * 100 / len(samples), 1)}
           for function, count in pc_counts.most_common(25)] if samples else []
    batches.append({'samples': len(samples), 'top_pc': top, 'top_lr': lr_counts.most_common(15)})
result = {'elf': str(elf), 'batches': batches}
(support / 'validation' / (name + '-cpu.json')).write_text(json.dumps(result, indent=2), encoding='utf-8')
print(json.dumps(result, indent=2))
