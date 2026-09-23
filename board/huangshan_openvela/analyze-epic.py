"""Summarize the same-image hardware/software A/B runs; fail on incomplete runs."""
from pathlib import Path
import hashlib
import json
import re
import statistics

root = Path(__file__).resolve().parent
image = Path('D:/wsl_ubuntu/setup/velamotion-epic.bin')
groups = {'off': {}, 'on': {}}
runs = []
for name in ['native-off', 'native-on', 'app-off', 'app-on', 'app-on2', 'app-off2']:
    prefix = 'epic-final-' + name
    rows = json.loads((root / 'validation' / (prefix + '.json')).read_text(encoding='utf-8-sig'))
    assert len(rows) == (18 if name.startswith('native') else 22), (name, len(rows))
    log = (root / 'logs' / (prefix + '.log')).read_text(encoding='utf-8-sig')
    assert 'selftest=1 cases=9' in log and 'Assertion failed' not in log
    stats = re.findall(r'VMC_EPIC enabled=[^\r\n]+', log)[-1]
    values = {k: int(v) for k, v in re.findall(r'(\w+)=(\d+)', stats)}
    mode = 'off' if '-off' in name else 'on'
    assert values['faults'] == 0 and values['verified'] == 1
    assert values['enabled'] == (mode == 'on')
    if mode == 'on':
        assert values['fills'] > 0
    else:
        assert values['fills'] == values['copies'] == 0
    for row in rows:
        groups[mode].setdefault(row['label'], []).append(row['ms'])
    if name.startswith('native'):
        groups[mode].setdefault('cached-native', []).extend(row['ms'] for row in rows[6:])
    else:
        groups[mode].setdefault('cached-idle-next', []).extend(
            row['ms'] for row in [r for r in rows if r['label'] == 'idle-next'][4:])
    runs.append({'name': prefix, 'samples': len(rows), 'gpu': values})

comparison = {}
for label in groups['off']:
    row = {}
    for mode in ['off', 'on']:
        vals = groups[mode][label]
        row[mode] = {'n': len(vals), 'median_ms': statistics.median(vals),
                     'min_ms': min(vals), 'max_ms': max(vals)}
    row['reduction_percent'] = round(100 * (1 - row['on']['median_ms'] / row['off']['median_ms']), 2)
    comparison[label] = row

log = (root / 'logs/epic-final-boot.log').read_text(encoding='utf-8-sig')
micro = [{k: int(v) for k, v in re.findall(r'(\w+)=(\d+)', line)}
         for line in log.splitlines() if 'VMC_EPIC bench pixels=' in line]
assert len(micro) == 3 and all(row['ok'] == 1 for row in micro)
result = {'firmware_sha256': hashlib.sha256(image.read_bytes()).hexdigest(),
          'firmware_bytes': image.stat().st_size, 'runs': runs, 'comparison': comparison,
          'primitive_benchmark': micro, 'latency_target_met': False,
          'measurement': 'Synthetic LVGL press to changed-page refresh completion; includes nominal '
          '100ms press and scheduling delay; excludes serial queue, physical touch sensor and panel response.',
          'scope': 'Opaque RGB565 fill >=16384 pixels, non-overlapping RAM RGB565 copy >=4096 pixels; '
          '4096-pixel strips. Mask, alpha, text, gradient, transform and XIP sources stay on CPU.',
          'fault_test': 'One completed strip followed by an injected pre-submit error; CPU repairs whole '
          'destination. This does not establish recovery from a physically hung DMA bus master.'}
(root / 'validation/epic-comparison.json').write_text(
    json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(result, ensure_ascii=False, indent=2))
