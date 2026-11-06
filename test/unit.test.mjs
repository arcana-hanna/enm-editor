// Fixture-free tests: run in CI without any real .enm file (no student data in the repo).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import ENM from '../src/enm.js';
import I from '../src/import.js';

const grades = [
  ...['1+', '1', '1-', '2+', '2', '2-', '3+', '3', '3-', '4+', '4', '4-', '5+', '5', '5-', '6'].map((k, i) => ({ krz: k, art: 'N', text: '', punkte: String(15 - i), sort: i })),
  { krz: 'E1', art: 'Z', text: '', punkte: '--', sort: 20 }, { krz: 'E2', art: 'Z', text: '', punkte: '--', sort: 21 }, { krz: 'E3', art: 'Z', text: '', punkte: '--', sort: 22 },
  { krz: 'NT', art: 'Z', text: 'nicht teilgenommen', punkte: '--', sort: 30 },
];
grades.find(g => g.krz === '1').text = 'sehr gut'; grades.find(g => g.krz === '2').text = 'gut';
const mk = (id, name, krz = '', klasse = '07A', fach = 'M') => ({ id, name, klasse, fach, krz, locked: false });
const roster = () => [
  mk('a', 'Hübner, Ole'), mk('b', 'Fiedler, Mara Jo'), mk('c', 'Zorn, Mara Lee'), mk('d', 'Wirth, Jonah'),
  mk('e', 'Sommer, Ida Marie'), mk('f', 'Kellermanns, Emil', '3'), mk('g', 'Tanner, Ruben'), mk('h', 'Quast, Greta Ann'), mk('x', 'Fremd, Elif', '', '07B', 'M'),
];
function fakeDoc() {
  const rows = roster(), edits = [];
  return { rows, grades, edits, setGrade(id, krz) { edits.push([id, krz]); const r = rows.find(x => x.id === id); r.krz = krz; return { ok: true }; } };
}
function session(text, opts = {}) {
  const doc = opts.doc || fakeDoc();
  const { rows } = I.parseTable(text, grades);
  const g = I.guessMapping(rows, grades);
  const entries = I.buildEntries(rows, opts.header ?? g.header, opts.roles ?? g.roles, grades);
  return { doc, g, s: new I.ImportSession(doc, entries, opts.target || { fach: 'M', klasse: '07A' }) };
}
const state = (s, raw) => { const x = s.all().find(v => s.entries[v.i].raw === raw); return x.state + (x.reason ? '/' + x.reason : ''); };

test('grade parsing', () => {
  const n = (t) => I.normGrade(t, grades);
  assert.equal(n('2+'), '2+'); assert.equal(n('2 +'), '2+'); assert.equal(n('+2'), '2+'); assert.equal(n('2−'), '2-');
  assert.equal(n('e2'), 'E2'); assert.equal(n('sehr gut'), '1'); assert.equal(n(''), ''); assert.equal(n('2,5'), null); assert.equal(n('7'), null);
});
test('name + grade in one cell', () => {
  const sp = (t) => I.splitCombined(t, grades);
  assert.deepEqual(sp('Mara F 2+'), { name: 'Mara F', tok: '2+' }); assert.deepEqual(sp('Ole2'), { name: 'Ole', tok: '2' });
  assert.deepEqual(sp('Ida Marie sehr gut'), { name: 'Ida Marie', tok: 'sehr gut' }); assert.equal(sp('Mara F').tok, '');
  assert.equal(sp('Ole 2,5').tok, '2,5');
});
test('table shapes', () => {
  const shape = (t) => { const p = I.parseTable(t, grades); const g = I.guessMapping(p.rows, grades); return g.roles.join() + (g.header ? '+h' : ''); };
  assert.equal(shape('Name\tNote\nOle\t3\nIda\t4'), 'name,grade+h');
  assert.equal(shape('| Name | Note |\n|---|---|\n| Ole | 3 |'), 'name,grade+h');
  assert.equal(shape('Vorname;Nachname;Note\nOle;Hübner;3'), 'first,last,grade+h');
  assert.equal(shape('Ole,3\nIda,4'), 'name,grade');
  assert.equal(shape('Sommer, Ida 4\nHübner, Ole 3'), 'combined');
  assert.equal(shape('Mara F 2+\nOle 3'), 'combined');
});
test('matching tiers: exact is automatic, shorthand needs confirmation', () => {
  const { s } = session(['Ruben 3', 'Mara 2', 'Mara F 2', 'Mara Zorn 1', 'Hübner, Ole 2+', 'Emil Kellerman 4', 'Jonas 3', 'Lotta 2', 'Greta 2,5', 'Ida Marie sehr gut', 'Elif 2'].join('\n'));
  assert.equal(state(s, 'Ruben 3'), 'proposed'); assert.equal(state(s, 'Mara 2'), 'decide/ambiguous');
  assert.equal(state(s, 'Mara F 2'), 'proposed'); assert.equal(state(s, 'Mara Zorn 1'), 'ready');
  assert.equal(state(s, 'Hübner, Ole 2+'), 'ready');
  assert.equal(state(s, 'Emil Kellerman 4'), 'proposed'); assert.match(state(s, 'Jonas 3'), /^decide/); assert.equal(state(s, 'Lotta 2'), 'decide/none');
  assert.equal(state(s, 'Greta 2,5'), 'badgrade'); assert.equal(state(s, 'Ida Marie sehr gut'), 'proposed');
  assert.equal(s.all().find(x => s.entries[x.i].raw === 'Mara F 2').id, 'b');          // Fiedler, not Zorn
  assert.equal(state(s, 'Elif 2'), 'decide/none');                                     // only exists in class 07B: out of scope, never guessed
});
test('umlaut spellings: ü, ue and u all match', () => {
  for (const t of ['Ole Hübner 3', 'Ole Huebner 3', 'Ole Hubner 3', 'hübner, ole 3']) assert.equal(state(session(t).s, t), 'ready', t);
});
test('apply is blocked until everything is decided and confirmed', () => {
  const { s, doc } = session('Ole 3\nMara 2\nLotta 2');
  s.overwrite = true;
  assert.equal(s.canApply(), false);
  s.choose(1, 'c'); s.choose(2, null); assert.equal(s.canApply(), false);            // proposal still unconfirmed
  s.confirmAllProposed(); assert.equal(s.canApply(), true);
  const res = s.apply();
  assert.equal(res.applied.length, 2); assert.deepEqual(doc.edits.map(e => e[0]).sort(), ['a', 'c']);
});
test('existing grades are protected unless overwrite is on', () => {
  const { s, doc } = session('Kellermanns, Emil 1');
  assert.equal(s.canApply(), false);                                                 // nothing would be set
  assert.equal(s.apply().kept.length, 1); assert.equal(doc.edits.length, 0);
  s.overwrite = true; assert.equal(s.canApply(), true);
});
test('two lines for one student are a conflict', () => {
  const { s } = session('Ole 3\nHübner Ole 2');
  assert.equal(s.all().filter(x => x.state === 'duplicate').length, 2); assert.equal(s.canApply(), false);
});
test('class / subject columns are checked against the chosen target', () => {
  const { s } = session('Klasse;Name;Fach;Note\n07A;Ole;M;3\n07B;Ole;M;3\n07A;Ole;AG;3');
  assert.equal(s.all()[1].reason, 'class'); assert.equal(s.all()[2].reason, 'subject');
});
test('failed edits are reported, not hidden', () => {
  const doc = fakeDoc(); doc.setGrade = () => ({ ok: false, reason: 'page-full' });
  const { s } = session('Ole 3', { doc }); s.confirmAllProposed(); s.overwrite = true;
  const res = s.apply(); assert.equal(res.failed.length, 1); assert.equal(res.failed[0].failure.reason, 'page-full');
});
test('enm.js rejects input that is not an .enm file', () => {
  for (const buf of [new Uint8Array(0), crypto.randomBytes(16384), Buffer.from('hello'.repeat(4000))]) assert.throws(() => ENM.open(buf), (e) => e.name === 'EnmError');
});
test('rc4 helper is symmetric', () => {
  const data = crypto.randomBytes(4096), key = Uint8Array.from([1, 2, 3, 4]);
  const { rc4 } = ENM._internal; assert.deepEqual(Buffer.from(rc4(key, rc4(key, data))), data);
});
