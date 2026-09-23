"""Check unchanged static UI and corner clearances after the refresh change."""
from pathlib import Path
import json
import subprocess
import sys
from PIL import Image, ImageChops

root = Path(__file__).resolve().parent
prefix = sys.argv[1] if len(sys.argv) > 1 else 'latency'
frames = [root / 'validation' / (prefix + '-' + name + '.png')
          for name in ['tools', 'app', 'coach', 'timeline', 'swipe-back', 'ready']]
assert len(frames) == 6, frames
corners = subprocess.check_output([sys.executable, str(root / 'audit-corners.py'),
                                  *map(str, frames)], text=True, encoding='utf-8')
(root / ('validation/' + prefix + '-corner-audit.json')).write_text(corners, encoding='utf-8')
pairs = [('font-subset-tools.png', prefix + '-tools.png'),
         ('font-subset-app.png', prefix + '-app.png'),
         (prefix + '-coach.png', prefix + '-swipe-back.png')]
comparisons = []
for before, after in pairs:
    a, b = (Image.open(root / 'validation' / name).convert('RGB') for name in (before, after))
    assert a.size == b.size == (390, 450)
    pixels = sum(any(pixel) for pixel in ImageChops.difference(a, b).getdata())
    comparisons.append({'before': before, 'after': after, 'changed_pixels': pixels})
    assert pixels == 0, comparisons[-1]
(root / ('validation/' + prefix + '-pixel-comparison.json')).write_text(
    json.dumps(comparisons, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'corners_passed': len(frames), 'comparisons': comparisons}, ensure_ascii=False))
