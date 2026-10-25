// Scaffold a module from modules/_template: npm run new-module -- <id> "<one-line description>"
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const [id, ...rest] = process.argv.slice(2);
const description = rest.join(' ').trim() || 'TODO: describe this module.';
if (!id || !/^[a-z][a-z0-9-]*$/.test(id)) {
  console.error('Usage: npm run new-module -- <id> "<one-line description>"   (id: lowercase, digits, dashes)');
  process.exit(1);
}
const root = path.resolve(import.meta.dirname, '..');
const src = path.join(root, 'modules', '_template');
const dest = path.join(root, 'modules', id);
if (fs.existsSync(dest)) { console.error(`modules/${id} already exists`); process.exit(1); }

const name = id.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
const table = id.replace(/-/g, '_') + '_items';
const camel = id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const Pascal = camel[0].toUpperCase() + camel.slice(1);
fs.cpSync(src, dest, { recursive: true });
fs.renameSync(path.join(dest, 'template.test.ts'), path.join(dest, `${id}.test.ts`));

const edit = (file, fn) => { const p = path.join(dest, file); fs.writeFileSync(p, fn(fs.readFileSync(p, 'utf8'))); };
edit('manifest.ts', (s) => s
  .replace(/\/\*\*[\s\S]*?\*\/\n/, `/** ${id} — ${description} */\n`)
  .replaceAll("'_template'", `'${id}'`)
  .replaceAll('template_items', table)
  .replaceAll('template.added', `${id}.added`)
  .replaceAll('template.below_target', `${id}.below_target`)
  .replaceAll('template_list', `${camel.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())}_list`)
  .replaceAll('TemplateService', `${Pascal}Service`)
  .replace("name: 'Template'", `name: '${name}'`)
  .replace("description: 'A minimal example module.'", `description: ${JSON.stringify(description)}`)
  .replace("defaultEnabled: false,", 'defaultEnabled: true,')
  .replace("id: 'template', label: 'Template', icon: 'Box', path: '/template'", `id: '${id}', label: '${name}', icon: 'Box', path: '/${id}'`)
  .replace("label: 'Template items below target today'", `label: '${name}: below target today'`));
edit('web/index.tsx', (s) => s
  .replaceAll('/api/_template/', `/api/${id}/`)
  .replaceAll("'_template'", `'${id}'`)
  .replaceAll('/template', `/${id}`)
  .replaceAll('TemplatePage', `${Pascal}Page`)
  .replaceAll('title="Template"', `title="${name}"`)
  .replaceAll("'template.open'", `'${id}.open'`)
  .replaceAll("'Open template'", `'Open ${name.toLowerCase()}'`)
  .replaceAll("group: 'Template'", `group: '${name}'`));
fs.writeFileSync(path.join(dest, `${id}.test.ts`), `import { describe, it, expect } from 'vitest';
import { testApp } from '../../tests/helpers';

describe('${id}', () => {
  it('adds and lists items', async () => {
    const app = await testApp({ at: '2026-11-01T10:00:00-05:00', only: ['${id}'] });
    const post = await app.req('POST', '/api/${id}/items', { title: 'First' });
    expect(post.status).toBe(200);
    const list = await app.req('GET', '/api/${id}/items');
    expect(list.json[0].title).toBe('First');
  });
});
`);
console.log(`Created modules/${id}. Running its test…`);
execFileSync('npx', ['vitest', 'run', `modules/${id}`], { stdio: 'inherit', cwd: root });
console.log(`\nNext: edit modules/${id}/manifest.ts and web/index.tsx (see docs/ADDING_A_MODULE.md).`);
