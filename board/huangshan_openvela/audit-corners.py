"""Check that the four 80x65-pixel corner regions contain no dark UI ink.

This complements visual review of board-rendered screenshots; it does not
measure the physical panel's corner radius or replace a touch/display test.
"""
from pathlib import Path
import json
import sys
from PIL import Image

results = []
for name in sys.argv[1:]:
    path = Path(name)
    frame = Image.open(path).convert('RGB')
    if frame.size != (390, 450):
        raise ValueError(f'Unexpected board resolution: {frame.size}')
    regions = {
        'top_left': (0, 0, 80, 65),
        'top_right': (310, 0, 390, 65),
        'bottom_left': (0, 385, 80, 450),
        'bottom_right': (310, 385, 390, 450),
    }
    counts = {}
    for label, (x0, y0, x1, y1) in regions.items():
        counts[label] = sum(
            0.2126*r + 0.7152*g + 0.0722*b < 150
            for y in range(y0, y1) for x in range(x0, x1)
            for r, g, b in [frame.getpixel((x, y))])
    results.append({'image': path.name, 'corner_dark_pixels': counts,
                    'passed': not any(counts.values())})
print(json.dumps(results, ensure_ascii=False, indent=2))
raise SystemExit(0 if all(r['passed'] for r in results) else 1)
