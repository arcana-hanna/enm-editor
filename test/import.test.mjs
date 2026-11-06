// Usage: node test/import.test.mjs <file.enm>
// Regression test on a REAL .enm (never commit one). It hard-codes no names: it picks
// students from the file itself, so any file with one class/subject of >= 6 students works.
import fs from 'node:fs';
import ENM from '../src/enm.js';
import I from '../src/import.js';

const path = process.argv[2];
if (!path) { console.error('usage: node test/import.test.mjs file.enm'); process.exit(2); }
let failed = 0;
const check = (name, ok, extra = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!ok) failed++; };
const skip = (name) => console.log('SKIP ' + name);
const open = () => ENM.open(fs.readFileSync(path));

// ---- pick the biggest (subject, class) group and derive test names from it
let doc = open();
const groups = new Map();
for (const r of doc.rows) { const k = r.fach + '\u0000' + r.klasse; (groups.get(k) || groups.set(k, []).get(k)).push(r); }
const grp = [...groups.values()].sort((a, b) => b.length - a.length)[0];
const target = { fach: grp[0].fach, klasse: grp[0].klasse };
const P = grp.map(r => I.prepStudent(r));
const firstCount = new Map(); for (const s of P) { const k = I.fold(s.firstGiven, 'a'); firstCount.set(k, (firstCount.get(k) || 0) + 1); }
const uniq = P.filter(s => firstCount.get(I.fold(s.firstGiven, 'a')) === 1 && s.firstGiven.length >= 5);
const dupFirst = [...firstCount].filter(([, n]) => n === 2).map(([k]) => P.filter(s => I.fold(s.firstGiven, 'a') === k));
check('sample has a usable group', grp.length >= 6 && uniq.length >= 5, `${grp.length} students in ${target.fach}/${target.klasse}`);
const [u0, u1, u2, u3, u4] = uniq;

function session(doc, text, opts = {}) {
  const { rows } = I.parseTable(text, doc.grades);
  const g = I.guessMapping(rows, doc.grades);
  const entries = I.buildEntries(rows, opts.header ?? g.header, opts.roles ?? g.roles, doc.grades);
  return { s: new I.ImportSession(doc, entries, opts.target || target), g, entries };
}
const stateOf = (s, raw) => { const x = s.all().find(v => s.entries[v.i].raw === raw); return x ? x.state + (x.reason ? '/' + x.reason : '') : '?'; };
const get = (s, raw) => s.all().find(v => s.entries[v.i].raw === raw);

// ---- 1. matching tiers
const lines = [
  `${u0.firstGiven} ${u0.last} 3`,          // full name                  -> matched
  `${u1.last}, ${u1.firstAll} 2+`,          // "Last, First"              -> matched
  `${u2.firstGiven} 4`,                     // first name only            -> proposed
  `${u3.firstGiven} ${u3.last.slice(0, 2)} 1-`, // partial surname        -> proposed
  `${u4.firstGiven.slice(0, -1)}x 3`,       // typo in the first name     -> never automatic
  `Zzyzxqw 2`,                              // nobody                     -> decide/none
  'Zzyzxqv 2,5',                            // bad grade (and unknown name)
];
let { s } = session(doc, lines.join('\n'));
check('single "name grade" column detected', I.guessMapping(I.parseTable(lines.join('\n'), doc.grades).rows, doc.grades).roles.join() === 'combined');
check('full name matched automatically', stateOf(s, lines[0]) === 'ready' && get(s, lines[0]).matchKind === 'matched');
check('"Last, First" matched automatically', stateOf(s, lines[1]) === 'ready');
check('first name only is proposed, not trusted', stateOf(s, lines[2]) === 'proposed');
check('first name + partial surname is proposed', stateOf(s, lines[3]) === 'proposed' && get(s, lines[3]).id === u3.id);
check('typo is never matched automatically', /^decide/.test(stateOf(s, lines[4])));
check('unknown name -> decide/none', stateOf(s, lines[5]) === 'decide/none');
check('bad grade flagged', stateOf(s, lines[6]).startsWith('badgrade') || stateOf(s, lines[6]).startsWith('decide'));
check('cannot apply while rows are open', !s.canApply() && s.summary().blocking > 0);

// ---- 2. same first name twice (if the sample has such a pair)
if (dupFirst.length) {
  const [x, y] = dupFirst[0];
  const l1 = `${x.firstGiven} 2`, l2 = `${x.firstGiven} ${x.last.slice(0, 1)} 3`;
  ({ s } = session(doc, l1 + '\n' + l2));
  const distinct = !I.fold(x.last, 'a').startsWith(I.fold(y.last, 'a').slice(0, 1));
  check('shared first name is ambiguous', stateOf(s, l1) === 'decide/ambiguous' && get(s, l1).candidates.length === 2);
  if (distinct) check('last-name initial disambiguates', stateOf(s, l2) === 'proposed' && get(s, l2).id === x.id);
  else skip('initial test (both surnames start with the same letter)');
} else skip('shared-first-name tests (no such pair in the sample)');

// ---- 3. resolve everything like a user, apply, save, re-open
doc = open();
({ s } = session(doc, [`${u0.firstGiven} 3`, `${u1.firstGiven} 2+`, 'Zzyzxqw 2'].join('\n')));
s.choose(2, null); s.overwrite = true;
check('proposals still block until confirmed', !s.canApply());
s.confirmAllProposed();
check('after confirming, apply is possible', s.canApply());
const before = new Map(doc.rows.map(r => [r.id, r.krz]));
const res = s.apply();
const changed = doc.rows.filter(r => before.get(r.id) !== r.krz);
check('apply writes pending edits', res.applied.length > 0 && res.applied.length === changed.length, `${res.applied.length} applied`);
const again = ENM.open(doc.save());
check('saved file re-opens with the imported grades', changed.every(r => again.rows.find(x => x.id === r.id).krz === r.krz));

// ---- 4. existing grades are protected unless "overwrite" is on
doc = open();
const graded = grp.find(r => /^[1-6]$/.test(r.krz));
const other = ['1', '2', '3', '4', '5', '6'].find(g => g !== graded.krz);
({ s } = session(doc, `${graded.name} ${other}`));
check('existing grade kept by default', get(s, `${graded.name} ${other}`).state === 'ready' && !s._willSet(get(s, `${graded.name} ${other}`)));
s.overwrite = true;
check('overwrite switch makes it a change', s._willSet(get(s, `${graded.name} ${other}`)));

// ---- 5. two lines for one student
doc = open();
({ s } = session(doc, `${u0.firstGiven} 3\n${u0.firstGiven} ${u0.last} 2`));
check('two lines for one student -> duplicate', s.all().filter(x => x.state === 'duplicate').length === 2 && !s.canApply());

// ---- 6. other input shapes
doc = open();
let r;
r = session(doc, `| Name | Note |\n|---|---|\n| ${u0.firstGiven} | 3 |\n| ${u1.firstGiven} | 4 |`);
check('markdown table with header', r.g.header && r.g.roles.join() === 'name,grade' && r.entries.length === 2);
r = session(doc, `Vorname\tNachname\tNote\n${u0.firstGiven}\t${u0.last}\t3\n${u1.firstGiven}\t${u1.last}\t4`);
check('separate first/last columns', r.g.roles.join() === 'first,last,grade' && r.s.all().every(x => x.state === 'ready'));
r = session(doc, `Klasse;Name;Fach;Note\n${target.klasse};${u0.firstGiven};${target.fach};3\n${target.klasse}X;${u0.firstGiven};${target.fach};3\n${target.klasse};${u0.firstGiven};Zzz;3`);
check('class/subject columns recognised and checked', r.g.roles.join() === 'class,name,subject,grade' && r.s.all()[1].reason === 'class' && r.s.all()[2].reason === 'subject');
r = session(doc, `${u0.last}, ${u0.firstAll} 4\n${u1.last}, ${u1.firstAll} 3`);
check('"Last, First Grade" stays one column', r.g.roles.join() === 'combined' && r.s.all().every(x => x.state === 'ready'));

// ---- 7. a full page is reported, not hidden
doc = open();
doc.pageFree = () => 0;
const empty = grp.find(x => x.krz === '');
if (empty) {
  ({ s } = session(doc, `${empty.name} 2`));
  const out = s.apply();
  check('page-full edit is reported as failed', out.failed.length === 1 && out.failed[0].failure.reason === 'page-full' && doc.changeCount === 0);
} else skip('page-full test (no empty grade in the sample group)');

process.exit(failed ? 1 : 0);
