"""Remove unused and overridden flat class rules in the D-drive build copy.

Keep surviving declarations in their original cascade order. Do not merge
classes or reorder rules: an element can carry several equally specific classes.
"""
import re
import sys
from pathlib import Path

def optimize(source):
    template = source.split('<template>', 1)[1].split('</template>', 1)[0]
    attributes = re.findall(r'\bclass="([^"]*)"', template)
    if any('{{' in value for value in attributes):
        raise ValueError('Dynamic class binding needs an explicit keep list')
    used = set(' '.join(attributes).split())
    start = source.index('<style>') + len('<style>')
    end = source.index('</style>', start)
    css = re.sub(r'/\*.*?\*/', '', source[start:end], flags=re.S)
    rules = []
    last = {}
    for match in re.finditer(r'([^{}]+)\{([^{}]*)\}', css):
        declarations = [tuple(item.strip().split(':', 1)) for item in match[2].split(';') if item.strip()]
        declarations = [(key.strip(), value.strip()) for key, value in declarations]
        for selector in match[1].split(','):
            selector = selector.strip()
            if not re.fullmatch(r'\.[\w-]+', selector):
                raise ValueError('Only flat class rules supported: ' + selector)
            if selector[1:] not in used:
                continue
            index = len(rules)
            rules.append((selector, declarations))
            for j, (key, value) in enumerate(declarations):
                last[selector, key] = (index, j)
    output = []
    for i, (selector, declarations) in enumerate(rules):
        keep = ['  ' + key + ': ' + value + ';' for j, (key, value) in enumerate(declarations)
                if last[selector, key] == (i, j)]
        if keep:
            output.append(selector + ' {\n' + '\n'.join(keep) + '\n}')
    optimized = '\n' + '\n'.join(output) + '\n'
    return source[:start] + optimized + source[end:], len(source[start:end]), len(optimized)

if __name__ == '__main__':
    path = Path(sys.argv[1]).resolve()
    result, before, after = optimize(path.read_text(encoding='utf-8'))
    path.write_bytes(result.encode('utf-8'))
    print(f'Watch CSS: {before} -> {after} chars; cascade order preserved')
