// Usage: node test/replay.mjs <unchanged.enm> <changed-by-official-tool.enm>
// Replays the edits through enm.js and checks that the result is byte-identical
// to what the official Windows tool produced. Also checks the safety nets.
import fs from 'node:fs';
import crypto from 'node:crypto';
import ENM from '../src/enm.js';

const [, , plainPath, officialPath] = process.argv;
if (!plainPath || !officialPath) { console.error('usage: node test/replay.mjs unchanged.enm changed.enm'); process.exit(2); }
const plain = fs.readFileSync(plainPath), official = fs.readFileSync(officialPath);
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
let failed = 0;
const check = (name, ok, extra = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!ok) failed++; };

// 1. open, no edits -> byte-identical file
let doc = ENM.open(plain);
check('opens file', doc.rows.length > 0, `${doc.rows.length} rows, ${doc.grades.length} grades`);
check('save without edits is byte-identical', md5(doc.save()) === md5(plain));

// 2. replay the six edits (identified by page:row, found by comparing the two files)
const ref = ENM.open(official);
let n = 0;
for (let i = 0; i < doc.rows.length; i++) {
  const a = doc.rows[i], b = ref.rows[i];
  if (a.krz !== b.krz) { const r = doc.setGrade(a.id, b.krz); n++; if (!r.ok) check('edit ' + a.id, false, r.reason); }
}
check('found and replayed 6 edits', n === 6 && doc.changeCount === 6, `${n} edits`);
const out = doc.save();
check('result is byte-identical to the official tool\'s file', md5(out) === md5(official), md5(out) + ' vs ' + md5(official));

// 3. undoing an edit restores the original file exactly
doc = ENM.open(plain);
const r0 = doc.rows.find(r => r.krz === '');
doc.setGrade(r0.id, '2+'); doc.setGrade(r0.id, '');
check('edit then revert = byte-identical to input', doc.changeCount === 0 && md5(doc.save()) === md5(plain));

// 4. unknown grade and capacity are refused without changing anything
doc = ENM.open(plain);
check('unknown grade refused', doc.setGrade(r0.id, '9x').reason === 'unknown-grade');
let refused = null, done = 0;
for (const r of doc.rows) { // fill every empty row with a 2-char grade until a page is full
  if (r.krz !== '') continue;
  const res = doc.setGrade(r.id, '2+'); if (res.ok) done++; else { refused = res; break; }
}
console.log('     (filled', done, 'empty rows; page-full reached:', !!refused, refused ? JSON.stringify(refused) : '', ')');
check('save after capacity probe still verifies', (() => { try { ENM.open(doc.save()); return true; } catch (e) { console.log(e.message); return false; } })());

// 5. garbage input is rejected cleanly
for (const [label, buf] of [['empty', new Uint8Array(0)], ['random', crypto.randomBytes(8192)], ['text', Buffer.from('hello'.repeat(2000))]]) {
  let code = null; try { ENM.open(buf); } catch (e) { code = e.code || e.name; }
  check('rejects ' + label + ' input', !!code, String(code));
}
process.exit(failed ? 1 : 0);
