"""Compare mask coverage on the same image; keep acknowledgement and save distinct."""
from pathlib import Path
import json
import re
import statistics

root = Path(__file__).resolve().parent
result = {}
for name in ('expanded-final-off', 'expanded-final-on'):
    rows = json.loads((root / 'validation' / (name + '.json')).read_text(encoding='utf-8-sig'))
    log = (root / 'logs' / (name + '.log')).read_text(encoding='utf-8-sig')
    groups = {}
    for row in rows:
        groups.setdefault(row['label'], []).append(row['ms'])
    groups['cached-idle-next'] = groups['idle-next'][4:]
    stages = {key: int(value) for key, value in re.findall(r'VMC_STOP_STAGE name=(\w+) ms=(\d+)', log)}
    # Serial output can split even a field name across receive boundaries.
    flat = log.replace('\r', '').replace('\n', '')
    gpu = re.findall(r'VMC_EPIC enabled=1 verified=1 fills=\d+.*?mask_enabled=\d', flat)[-1]
    assert 'faults=0' in gpu and 'mask_verified=1' in gpu, gpu
    assert 'VMC_SESSION_FINALIZED' in log and 'VMC_SESSION_FINALIZE_ERROR' not in log
    result[name] = {
        'operations': len(rows),
        'latency': {key: {'median_ms': statistics.median(values), 'range_ms': [min(values), max(values)], 'n': len(values)} for key, values in groups.items() if values},
        'stop_stages_ms': stages,
        'persisted_from_stop_entry_ms': int(re.search(r'VMC_SESSION_PERSISTED elapsed_ms=(\d+) persisted=true', log)[1]),
        'finalized_vm_from_stop_entry_ms': int(re.search(r'VMC_SESSION_FINALIZED elapsed_ms=(\d+) persisted=true', log)[1]),
        'store': dict((k, int(v)) for k, v in re.findall(r'(stringify_ms|submit_ms|chars)=(\d+)', log)),
        'gpu': dict((k, int(v)) for k, v in re.findall(r'(\w+)=(\d+)', gpu)),
    }
result['measurement'] = 'Same image, base EPIC on, mask off/on. Synthetic press-to-changed-page refresh includes ~100ms press. Save completion is measured separately from stop handler entry and is not photon latency. One run per mode; no statistical significance claim.'
(root / 'validation/expanded-comparison.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(result, ensure_ascii=False, indent=2))
