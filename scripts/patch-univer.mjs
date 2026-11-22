// Apply the same pinned AST cache change when installing with npm.
import {readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root = new URL('../node_modules/@univerjs/engine-formula/', import.meta.url);
const patch = readFileSync(new URL('../patches/@univerjs__engine-formula@1.5.2.patch', import.meta.url), 'utf8');
for (const section of patch.split(/^--- a\//m).slice(1)) {
    const [path, ...lines] = section.trimEnd().split('\n');
    const oldLine = lines.find(line => /^-\s/.test(line))?.slice(1);
    const newLine = lines.find(line => /^\+\s/.test(line))?.slice(1);
    if (!oldLine || !newLine) throw new Error('Invalid Univer AST cache patch');
    const target = fileURLToPath(new URL(path, root));
    const bytes = readFileSync(target, 'utf8');
    if (bytes.includes(newLine)) continue;
    if (!bytes.includes(oldLine)) throw new Error(`Univer AST cache patch does not apply to ${path}`);
    writeFileSync(target, bytes.replace(oldLine, newLine));
}
