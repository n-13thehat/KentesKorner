import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
function walk(directory, extensions) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...walk(path, extensions));
    else if (extensions.some(ext => entry.name.endsWith(ext))) found.push(path);
  }
  return found;
}

const javascript = [...walk(join(root, 'js'), ['.js']), ...walk(join(root, 'electron'), ['.js'])];
const python = [
  ...walk(join(root, 'batocera'), ['.py']),
  ...walk(join(root, 'scripts'), ['.py']),
  ...readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.py'))
    .map(entry => join(root, entry.name)),
];

for (const file of javascript) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}
for (const file of python) {
  execFileSync(process.env.PYTHON || 'python', ['-c',
    'import ast, pathlib, sys; ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"), filename=sys.argv[1])',
    file], { stdio: 'inherit' });
}
process.stdout.write(`Syntax check passed for ${javascript.length} JavaScript and ${python.length} Python files.\n`);
