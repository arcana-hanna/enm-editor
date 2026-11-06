// Builds dist/index.html: src/index.html with src/enm.js and src/import.js inlined,
// so the result is ONE self-contained file (also copied to dist/enm-editor.html for sharing).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (f) => fs.readFileSync(path.join(root, 'src', f), 'utf8');
let html = src('index.html');

for (const f of ['enm.js', 'import.js']) {
  const tag = `<script src="${f}"></script>`;
  if (!html.includes(tag)) throw new Error(`src/index.html does not reference ${f}`);
  const code = src(f).replace(/<\/script/gi, '<\\/script');
  html = html.replace(tag, () => `<script>\n${code}\n</script>`);
}

const sha = (process.env.GITHUB_SHA || '').slice(0, 7);
const date = new Date().toISOString().slice(0, 10);
const info = `Build ${date}${sha ? ' · ' + sha : ''}`;
if (!html.includes('<span class="ver">dev</span>')) throw new Error('version marker missing in src/index.html');
html = html.replace('<span class="ver">dev</span>', `<span class="ver">${info}</span>`);

if (/<script[^>]*\ssrc=/i.test(html)) throw new Error('built file still references an external script');

const out = path.join(root, 'dist');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'index.html'), html);
fs.writeFileSync(path.join(out, 'enm-editor.html'), html);
fs.writeFileSync(path.join(out, '.nojekyll'), '');
console.log(`dist/index.html  ${(html.length / 1024).toFixed(0)} KB  (${info})`);
