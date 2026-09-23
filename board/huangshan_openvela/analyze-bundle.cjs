const fs = require('fs');
const acorn = require('D:/wsl_ubuntu/app-work/velamotion_coach/node_modules/acorn');
const source = fs.readFileSync(0, 'utf8');
const tree = acorn.parse(source, {ecmaVersion:'latest', sourceType:'module'});
const bytes = n => Buffer.byteLength(source.slice(n.start,n.end),'utf8');
const modules=[], functions=[], arrays=[];
function walk(n) {
  if (!n || typeof n !== 'object') return;
  if (n.type === 'ObjectExpression' && n.properties.length > 10 &&
      n.properties.every(p => p.key && typeof p.key.value === 'number')) {
    for (const p of n.properties) {
      const code = source.slice(p.start,p.end);
      modules.push({id:p.key.value,bytes:bytes(p),exports:[...new Set([...code.matchAll(/\b\w+\.([A-Za-z_$][\w$]*)=/g)].map(x=>x[1]))].slice(0,18)});
    }
  }
  if (n.type === 'AssignmentExpression' && n.right.type === 'FunctionExpression')
    functions.push({target:source.slice(n.left.start,n.left.end),start:n.right.start,end:n.right.end,bytes:bytes(n.right)});
  if (n.type === 'ArrayExpression' && n.start === source.indexOf('[[[[0,'))
    arrays.push({name:'compiled_styles',start:n.start,end:n.end,bytes:bytes(n),rules:n.elements.length});
  for (const [key,value] of Object.entries(n)) {
    if (key==='start'||key==='end') continue;
    if (Array.isArray(value)) value.forEach(walk); else if (value && typeof value==='object') walk(value);
  }
}
walk(tree);
console.log(JSON.stringify({modules:modules.sort((a,b)=>b.bytes-a.bytes),arrays,functions:functions.sort((a,b)=>b.bytes-a.bytes).slice(0,12)},null,2));
