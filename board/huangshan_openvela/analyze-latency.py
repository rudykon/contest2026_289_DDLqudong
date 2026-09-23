"""Summarize board-side synthetic input measurements and optional phase traces."""
from pathlib import Path
import json
import re
import statistics
import sys

root = Path(__file__).resolve().parent
results = {}
for name in sys.argv[1:]:
    samples = json.loads((root / 'validation' / (name + '.json')).read_text(encoding='utf-8-sig'))
    groups = {}
    for row in samples:
        groups.setdefault(row['label'], []).append(row['ms'])
    if 'idle-next' in groups:
        groups['cached-idle-next'] = groups['idle-next'][4:]
    summary = {key: {'n': len(values), 'median_ms': statistics.median(values),
                     'min_ms': min(values), 'max_ms': max(values)}
               for key, values in groups.items() if values}
    traces, current = [], None
    log = (root / 'logs' / (name + '.log')).read_text(encoding='utf-8-sig')
    for line in log.splitlines():
        if 'echo "tap ' in line:
            current = {'frames': []}
        if current is None:
            continue
        if 'VMC_STAGE refresh=' in line and 'pending=1' in line:
            current['frames'].append({key: int(value) for key, value in
                                     re.findall(r'(\w+)=(\d+)', line)})
        if 'VMC_STAGE release_at=' in line:
            current.update({key: int(value) for key, value in re.findall(r'(\w+)=(\d+)', line)})
        if 'VMC_PERF input_to_refresh_ms=' in line:
            current['sample'] = samples[len(traces)]
            current['phase_totals_ms'] = {key: sum(frame[key] for frame in current['frames'])
                                         for key in ['refresh', 'layout', 'draw', 'flush']}
            traces.append(current)
            current = None
    assert len(traces) == len(samples), (name, len(traces), len(samples))
    result = {'summary': summary, 'traces': traces,
              'measurement': 'Synthetic LVGL press to changed-page refresh completion; '
                             'includes nominal 100ms press and its scheduling delay; '
                             'excludes serial queue, physical sensor sampling and panel response.'}
    (root / 'validation' / (name + '-analysis.json')).write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    results[name] = summary
print(json.dumps(results, ensure_ascii=False, indent=2))
