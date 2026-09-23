"""Compare the toolkit's compiled styles, including shorthand expansion."""
from pathlib import Path
import zipfile
import json
import subprocess

root = Path(__file__).resolve().parent
app = root.parent.parent / 'quickapp/velamotion_coach'
def expression(path):
    with zipfile.ZipFile(path) as archive:
        text = archive.read('pages/index/index.js').decode()
    start = text.index('[[[[0,')
    depth = 0
    quote = None
    escaped = False
    for index in range(start, len(text)):
        char = text[index]
        if quote:
            if escaped: escaped = False
            elif char == '\\': escaped = True
            elif char == quote: quote = None
        elif char in '\"\'': quote = char
        elif char == '[': depth += 1
        elif char == ']':
            depth -= 1
            if depth == 0: return text[start:index+1]
    raise ValueError('Unterminated style array')

before = expression(root / 'validation/perf-cached-untrimmed.rpk')
after = expression(app / 'dist/com.velamotion.coach.huangshan-dev.1.0.0.rpk')
source = (app / 'src/pages/index/index.ux').read_text(encoding='utf-8').split('</template>')[0]
import re
classes = sorted(set(tuple(value.split()) for value in re.findall(r'class="([^"]*)"', source)))
payload = json.dumps({'before': before, 'after': after, 'classes': classes})
script = r'''
const fs = require('fs'), vm = require('vm'), assert = require('assert/strict');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const before = vm.runInNewContext('(' + input.before + ')');
const after = vm.runInNewContext('(' + input.after + ')');
function resolved(rules, classes) {
  const out = {};
  for (const [selectors, props] of rules) {
    if (selectors.every(([kind, name]) => kind === 0 && classes.includes(name))) Object.assign(out, props);
  }
  return out;
}
let properties = 0;
for (const classes of input.classes) {
  const expected = resolved(before, classes);
  properties += Object.keys(expected).length;
  assert.deepEqual(resolved(after, classes), expected, classes.join(' '));
}
assert.ok(properties > 1000, 'comparison must exercise actual compiled properties');
console.log(JSON.stringify({elementClassSets:input.classes.length, beforeRules:before.length, afterRules:after.length, equivalent:true}));
'''
result = subprocess.run(['C:/Program Files/nodejs/node.exe', '-e', script], input=payload,
                        text=True, encoding='utf-8', capture_output=True)
print(result.stdout, result.stderr)
if result.returncode: raise SystemExit(result.returncode)
(root / 'validation/perf-style-equivalence.json').write_text(result.stdout, encoding='utf-8')
