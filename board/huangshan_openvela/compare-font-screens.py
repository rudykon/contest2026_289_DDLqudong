"""Compare static board-rendered screens across the font/resource change."""
from pathlib import Path
import json
from PIL import Image,ImageChops
root=Path(__file__).resolve().parent/'validation'
pairs=[('tools-menu.png','font-subset-tools.png'),
       ('tools-final-about.png','font-subset-about.png'),
       ('tools-final-stopwatch-zero.png','font-subset-stopwatch.png'),
       ('tools-final-app.png','font-subset-app.png')]
result=[]
for before,after in pairs:
    a,b=(Image.open(root/name).convert('RGB') for name in [before,after])
    assert a.size==b.size==(390,450)
    diff=ImageChops.difference(a,b)
    count=sum(diff.getpixel((x,y))!=(0,0,0) for y in range(diff.height) for x in range(diff.width))
    result.append({'before':before,'after':after,'changed_pixels':count,'identical':count==0})
(root/'font-subset-pixel-comparison.json').write_text(json.dumps(result,indent=2))
print(json.dumps(result,indent=2))
raise SystemExit(0 if all(r['identical'] for r in result) else 1)
