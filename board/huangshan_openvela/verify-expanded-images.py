"""Allow only one RGB565 channel level for EPIC alpha rounding; audit corners."""
from pathlib import Path
import json
import subprocess
import sys
from PIL import Image

root = Path(__file__).resolve().parent
frames = [root / 'validation' / ('expanded-' + name + '.png') for name in ('tools', 'app', 'coach', 'timeline', 'swipe-back', 'ready')]
corners = subprocess.check_output([sys.executable, str(root / 'audit-corners.py'), *map(str, frames)], text=True, encoding='utf-8')
(root / 'validation/expanded-corner-audit.json').write_text(corners, encoding='utf-8')
pairs = [('font-subset-tools.png', 'expanded-tools.png'), ('font-subset-app.png', 'expanded-app.png'), ('expanded-coach.png', 'expanded-swipe-back.png'), ('expanded-tools-mask-off.png', 'expanded-tools.png')]
out = []
for before, after in pairs:
    a, b = [Image.open(root / 'validation' / name).convert('RGB') for name in (before, after)]
    assert a.size == b.size == (390, 450)
    differences = [tuple(abs((x >> shift) - (y >> shift)) for x, y, shift in zip(pa, pb, (3, 2, 3))) for pa, pb in zip(a.get_flattened_data(), b.get_flattened_data())]
    result = {'before': before, 'after': after, 'changed_pixels': sum(any(d) for d in differences), 'max_rgb565_channel_delta': max(max(d) for d in differences)}
    out.append(result)
    assert result['max_rgb565_channel_delta'] <= 1, result
(root / 'validation/expanded-pixel-comparison.json').write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(out, ensure_ascii=False, indent=2))
