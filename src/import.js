/*
 * import.js - turn a pasted table (Excel / Word / Markdown / CSV) into grade edits,
 * with an interactive matching step. No dependencies, runs in browsers and Node.
 *
 * Principle: only an exact full-name match is trusted automatically. Everything
 * else ("Mara", "Mara F", a typo) is proposed to the user and needs an explicit
 * confirmation. Nothing is written to the document until the user applies it,
 * and even then it only becomes a normal, undoable pending edit.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ENMImport = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- text normalisation --------------------------------------------------
  // mode 'e': ä->ae, ö->oe, ü->ue (Mueller); mode 'a': ä->a (Muller). A name matches if either mode agrees.
  function fold(s, mode) {
    s = String(s == null ? '' : s).toLowerCase().replace(/ß/g, 'ss').replace(/ø/g, 'o').replace(/ł/g, 'l').replace(/ı/g, 'i').replace(/đ/g, 'd');
    if (mode === 'e') s = s.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue');
    return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  }
  const eqAny = (a, b) => { const x = fold(a, 'e'), y = fold(b, 'e'); return (x !== '' && x === y) || (fold(a, 'a') !== '' && fold(a, 'a') === fold(b, 'a')); };
  const startsAny = (full, prefix) => ['e', 'a'].some(m => { const p = fold(prefix, m); return p !== '' && fold(full, m).startsWith(p); });
  function lev(a, b) {
    const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[n];
  }
  const normClass = (s) => fold(s, 'a').replace(/\s+/g, '').replace(/^0+(?=\d)/, '');

  // ---- grades --------------------------------------------------------------
  /** returns the grade abbreviation from the scale, '' for empty input, or null if not a valid grade */
  function normGrade(tok, grades) {
    if (tok == null) return '';
    let s = String(tok).trim().replace(/[−–—‐]/g, '-').replace(/\s+/g, '');
    if (s === '') return '';
    const up = s.toUpperCase();
    let g = grades.find(x => x.krz.toUpperCase() === up);
    if (g) return g.krz;
    const m = s.match(/^([+-])([1-6])$/);                       // "+2" -> "2+"
    if (m) { g = grades.find(x => x.krz === m[2] + m[1]); if (g) return g.krz; }
    const low = fold(s, 'e').replace(/ /g, '');                 // "sehr gut", "gut"
    g = grades.find(x => x.art === 'N' && /^[1-6]$/.test(x.krz) && fold(x.text, 'e').replace(/ /g, '') === low);
    return g ? g.krz : null;
  }
  const looksGradey = (t) => /^[+\-−]?\d+(?:[.,]\d+)?[+\-−]?$/.test(t);

  /** "Mara F 2+" -> {name:'Mara F', tok:'2+'}; also "Ole2" and "Ole - 2" */
  function splitCombined(text, grades) {
    const t = String(text == null ? '' : text).trim();
    if (!t) return { name: '', tok: '' };
    const clean = (n) => n.replace(/[\s:=,;\-–]+$/, '').trim();
    const two = t.match(/^(.*\S)\s+(\S+\s+\S+)$/);                // two-word grade such as "sehr gut"
    if (two && normGrade(two[2], grades)) return { name: clean(two[1]), tok: two[2] };
    const sp = t.match(/^(.*\S)\s+(\S+)$/);
    if (sp && (normGrade(sp[2], grades) || looksGradey(sp[2]))) return { name: clean(sp[1]), tok: sp[2] };
    const gl = t.match(/^(.*?[^\s\d+\-−])\s*([1-6][+\-−]?)$/);
    if (gl && normGrade(gl[2], grades)) return { name: clean(gl[1]), tok: gl[2] };
    return { name: t, tok: '' };
  }

  // ---- parsing pasted tables ----------------------------------------------
  function splitLine(line, d) {
    const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"' && cur === '') q = true;
      else if (c === d) { out.push(cur.trim()); cur = ''; }
      else cur += c;
    }
    out.push(cur.trim());
    return out;
  }
  const pad = (rows) => { const w = Math.max(0, ...rows.map(r => r.length)); return rows.map(r => r.concat(Array(w - r.length).fill(''))); };

  function parseTable(text, grades) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n').filter(l => l.trim() !== '');
    if (!lines.length) return { rows: [], delimiter: null };
    const frac = (d) => lines.filter(l => l.includes(d)).length >= Math.ceil(lines.length * 0.6);
    if (frac('|')) {                                              // Markdown table
      let rows = lines.map(l => { l = l.trim(); if (l.startsWith('|')) l = l.slice(1); if (l.endsWith('|')) l = l.slice(0, -1); return l.split('|').map(c => c.trim()); });
      rows = rows.filter(r => !r.every(c => /^:?-{2,}:?$/.test(c)));
      return { rows: pad(rows), delimiter: '|' };
    }
    const d = frac('\t') ? '\t' : frac(';') ? ';' : frac(',') ? ',' : null;
    if (!d) return { rows: lines.map(l => [l.trim()]), delimiter: null };
    let rows = pad(lines.map(l => splitLine(l, d)));
    if (d === ',' && rows[0].length === 2 && grades) {            // "Last, First Grade" is one column, not CSV
      const comb = rows.filter(r => { const s = splitCombined(r[1], grades); return s.tok && s.name; }).length;
      if (comb >= rows.length * 0.6) rows = lines.map(l => [l.trim()]);
    }
    return { rows, delimiter: d };
  }

  // ---- column roles --------------------------------------------------------
  const ROLES = ['ignore', 'name', 'first', 'last', 'grade', 'combined', 'class', 'subject'];
  function guessMapping(rows, grades) {
    if (!rows.length) return { header: false, roles: [] };
    const w = rows[0].length;
    const headerWords = (c) => {
      const f = fold(c, 'e');
      if (/^(vorname|first ?name|rufname)/.test(f)) return 'first';
      if (/^(nachname|familienname|last ?name|surname)/.test(f)) return 'last';
      if (/^(name|sch(ue|u)ler|schuelername|student)/.test(f)) return 'name';
      if (/^(note|noten|grade|zensur|ergebnis)/.test(f)) return 'grade';
      if (/^(klasse|class|kl)$/.test(f)) return 'class';
      if (/^(fach|subject)$/.test(f)) return 'subject';
      if (/^(punkte|pkte|points)/.test(f)) return 'ignore';
      return null;
    };
    const r0 = rows[0], r1 = rows[1];
    const r0Grade = r0.some(c => normGrade(c, grades));
    const kw = r0.map(headerWords);
    const r1Data = r1 && r1.some(c => normGrade(c, grades) || splitCombined(c, grades).tok);
    const header = !r0Grade && (kw.some(Boolean) || !!r1Data) && !r0.some(c => splitCombined(c, grades).tok && normGrade(splitCombined(c, grades).tok, grades));
    const data = header ? rows.slice(1) : rows;
    const roles = Array(w).fill('ignore');
    const used = new Set();
    for (let c = 0; c < w; c++) if (header && kw[c] && !used.has(kw[c]) && kw[c] !== 'ignore') { roles[c] = kw[c]; used.add(kw[c]); }
    for (let c = 0; c < w; c++) {
      if (roles[c] !== 'ignore' || (header && kw[c] === 'ignore')) continue;
      const cells = data.map(r => r[c]).filter(x => x !== '');
      if (!cells.length) continue;
      const gradeRate = cells.filter(x => normGrade(x, grades)).length / cells.length;
      const combRate = cells.filter(x => { const s = splitCombined(x, grades); return s.tok && s.name && /[a-zA-ZÀ-ÿ]/.test(s.name); }).length / cells.length;
      const alphaRate = cells.filter(x => /[a-zA-ZÀ-ÿ]{2,}/.test(x) && !normGrade(x, grades)).length / cells.length;
      if (!used.has('grade') && gradeRate >= 0.7) { roles[c] = 'grade'; used.add('grade'); }
      else if (!used.has('combined') && !used.has('name') && combRate >= 0.6) { roles[c] = 'combined'; used.add('combined'); }
      else if (!used.has('name') && !used.has('combined') && !used.has('first') && alphaRate >= 0.6) { roles[c] = 'name'; used.add('name'); }
    }
    return { header, roles };
  }

  /** rows + roles -> entries {line, raw, name, tok, klasse, fach} */
  function buildEntries(rows, header, roles, grades) {
    const col = (r) => roles.indexOf(r);
    const cName = col('name'), cFirst = col('first'), cLast = col('last'), cGrade = col('grade'), cComb = col('combined'), cClass = col('class'), cSubj = col('subject');
    const out = [];
    rows.forEach((row, i) => {
      if (header && i === 0) return;
      if (row.every(c => c === '')) return;
      let name = '', tok = '';
      if (cComb >= 0) { const s = splitCombined(row[cComb], grades); name = s.name; tok = s.tok; }
      else {
        if (cFirst >= 0 || cLast >= 0) {
          const f = cFirst >= 0 ? row[cFirst] : '', l = cLast >= 0 ? row[cLast] : '';
          name = l && f ? l + ', ' + f : (l || f);
        } else if (cName >= 0) name = row[cName];
        if (cGrade >= 0) tok = row[cGrade];
      }
      out.push({ line: i + 1, raw: row.filter(Boolean).join(' | '), name: String(name || '').trim(), tok: String(tok || '').trim(), klasse: cClass >= 0 ? row[cClass] : '', fach: cSubj >= 0 ? row[cSubj] : '' });
    });
    return out;
  }

  // ---- name matching -------------------------------------------------------
  function prepStudent(row) {
    const nm = row.name || '', i = nm.indexOf(',');
    const last = i >= 0 ? nm.slice(0, i).trim() : nm.split(/\s+/).slice(1).join(' ');
    const firstAll = i >= 0 ? nm.slice(i + 1).trim() : nm.split(/\s+/)[0] || '';
    const givens = firstAll.split(/[\s]+/).filter(Boolean);
    return { row, id: row.id, last, firstAll, firstGiven: givens[0] || '', givens };
  }
  function alternatives(text) {
    const t = text.replace(/\s+/g, ' ').trim(), alts = [];
    if (!t) return alts;
    const c = t.indexOf(',');
    if (c >= 0) { alts.push({ first: t.slice(c + 1).trim(), last: t.slice(0, c).trim() }); return alts; }
    const tk = t.replace(/\./g, ' ').split(/\s+/).filter(Boolean);
    alts.push({ first: tk[0], last: tk.slice(1).join(' ') });
    if (tk.length >= 2) alts.push({ first: tk.join(' '), last: '' });          // several given names, no surname
    if (tk.length >= 3) alts.push({ first: tk.slice(0, -1).join(' '), last: tk[tk.length - 1] });
    if (tk.length >= 2) alts.push({ first: tk.slice(1).join(' '), last: tk[0], reversed: true });
    return alts;
  }
  function scoreOne(alt, s) {
    const firstFull = eqAny(alt.first, s.firstAll), firstGiven = eqAny(alt.first, s.firstGiven);
    const firstMain = firstFull || firstGiven;
    const lastFull = alt.last ? eqAny(alt.last, s.last) : false;
    const lastPrefix = alt.last && !lastFull ? startsAny(s.last, alt.last) : false;
    const lastOk = !alt.last || lastFull || lastPrefix;
    if (alt.reversed) return firstMain && lastFull ? { score: 100, kind: 'exact' } : { score: 0 };
    if (firstMain && lastFull) return { score: 100, kind: 'exact' };
    if (firstMain && lastPrefix) return { score: 80, kind: 'initial' };
    if (firstMain && !alt.last) return { score: 60, kind: 'first' };
    if (!firstMain && s.givens.some(g => eqAny(alt.first, g)) && lastOk) return { score: 50, kind: 'other-given' };
    const a = fold(alt.first, 'a'), b = fold(s.firstGiven, 'a');
    if (a.length >= 4 && b.length >= 4 && lev(a, b) <= 1 && lastOk) return { score: 40, kind: 'similar' };
    return { score: 0 };
  }
  function candidatesFor(name, studs) {
    const alts = alternatives(name), out = [];
    for (const s of studs) {
      let best = { score: 0 };
      for (const a of alts) { const r = scoreOne(a, s); if (r.score > best.score) best = r; }
      if (best.score >= 40) out.push({ id: s.id, score: best.score, kind: best.kind });
    }
    return out.sort((x, y) => y.score - x.score);
  }

  // ---- the interactive session --------------------------------------------
  class ImportSession {
    /**
     * doc: ENM document; entries: from buildEntries; target: {fach, klasse ('' = all)}
     */
    constructor(doc, entries, target) {
      this.doc = doc; this.entries = entries; this.target = target;
      this.students = doc.rows.filter(r => r.fach === target.fach && (!target.klasse || r.klasse === target.klasse)).map(prepStudent);
      this.byId = new Map(this.students.map(s => [s.id, s]));
      this.userChoice = new Map();   // i -> id | null (skip)
      this.userGrade = new Map();    // i -> krz
      this.confirmed = new Set();
      this.overwrite = false;
      this.base = entries.map(e => this._base(e));
    }
    _base(e) {
      let studs = this.students;
      let scope = null;
      if (e.klasse) {
        if (this.target.klasse && normClass(e.klasse) !== normClass(this.target.klasse)) scope = 'class';
        else if (!this.target.klasse) studs = studs.filter(s => normClass(s.row.klasse) === normClass(e.klasse));
      }
      if (e.fach) {
        const a = fold(e.fach, 'a'), b = fold(this.target.fach, 'a');
        if (!(a.startsWith(b) || b.startsWith(a))) scope = scope || 'subject';
      }
      const cands = candidatesFor(e.name, studs);
      let auto = null, kind = null;
      if (cands.length && !scope) {
        const top = cands[0].score, peers = cands.filter(c => c.score === top);
        const strong = cands.filter(c => c.score >= 60);
        if (top === 100 && peers.length === 1) { auto = cands[0].id; kind = 'matched'; }
        else if (top >= 60 && peers.length === 1 && strong.length === 1) { auto = cands[0].id; kind = 'proposed'; }
      }
      return { cands, auto, kind, scope };
    }
    _grade(i) {
      if (this.userGrade.has(i)) return { krz: this.userGrade.get(i), ok: true };
      const e = this.entries[i], g = normGrade(e.tok, this.doc.grades);
      if (g === '') return { krz: '', ok: true, empty: true };
      return g === null ? { krz: null, ok: false } : { krz: g, ok: true };
    }
    /** full state of entry i */
    status(i) {
      const b = this.base[i], e = this.entries[i];
      const out = { i, name: e.name, base: b, candidates: b.cands, grade: null, gradeOk: true, id: null, state: 'decide', reason: null };
      const g = this._grade(i); out.grade = g.krz; out.gradeOk = g.ok;
      if (this.userChoice.has(i) && this.userChoice.get(i) === null) { out.state = 'skipped'; out.reason = 'user'; return out; }
      if (!e.name && !this.userChoice.has(i)) { out.state = 'skipped'; out.reason = 'no-name'; return out; }
      if (g.empty) { out.state = 'skipped'; out.reason = 'no-grade'; return out; }
      const chosen = this.userChoice.has(i) ? this.userChoice.get(i) : b.auto;
      out.id = chosen || null;
      if (!g.ok) { out.state = 'badgrade'; return out; }
      if (!chosen) { out.state = 'decide'; out.reason = b.scope || (b.cands.length > 1 ? 'ambiguous' : b.cands.length === 1 ? 'weak' : 'none'); return out; }
      const explicit = this.userChoice.has(i) || this.confirmed.has(i);
      out.state = explicit || b.kind === 'matched' ? 'ready' : 'proposed';
      out.matchKind = this.userChoice.has(i) ? 'chosen' : b.kind;
      const row = this.doc.rows.find(r => r.id === chosen);
      out.current = row ? row.krz : '';
      return out;
    }
    all() {
      const list = this.entries.map((_, i) => this.status(i));
      const users = new Map();
      for (const s of list) if (s.id && s.state !== 'skipped') (users.get(s.id) || users.set(s.id, []).get(s.id)).push(s);
      for (const arr of users.values()) if (arr.length > 1) for (const s of arr) { s.state = 'duplicate'; s.duplicateWith = arr.filter(x => x !== s).map(x => x.i); }
      return list;
    }
    summary() {
      const list = this.all(), n = (st) => list.filter(s => s.state === st).length;
      const ready = list.filter(s => s.state === 'ready');
      const willSet = ready.filter(s => this._willSet(s));
      const students = new Set(list.filter(s => s.id && s.state !== 'skipped').map(s => s.id));
      return {
        total: list.length, matched: ready.filter(s => s.matchKind === 'matched').length, ready: ready.length, proposed: n('proposed'), decide: n('decide'),
        badgrade: n('badgrade'), duplicate: n('duplicate'), skipped: n('skipped'), willSet: willSet.length,
        blocking: n('decide') + n('badgrade') + n('duplicate'), unconfirmed: n('proposed'),
        missing: this.students.filter(s => !students.has(s.id) && !s.row.locked),
      };
    }
    _willSet(s) {
      if (s.state !== 'ready') return false;
      if (s.current === s.grade) return false;
      if (s.current !== '' && !this.overwrite) return false;
      return true;
    }
    canApply() { const m = this.summary(); return m.blocking === 0 && m.unconfirmed === 0 && m.willSet > 0; }

    choose(i, id) { this.userChoice.set(i, id); }                 // id = student id, or null to skip
    unchoose(i) { this.userChoice.delete(i); this.confirmed.delete(i); }
    setGrade(i, krz) { this.userGrade.set(i, krz); }
    confirm(i) { this.confirmed.add(i); }
    confirmAllProposed() { for (const s of this.all()) if (s.state === 'proposed') this.confirmed.add(s.i); }

    /** write the plan into the document as normal pending edits */
    apply() {
      const res = { applied: [], unchanged: [], kept: [], failed: [] };
      for (const s of this.all()) {
        if (s.state !== 'ready') continue;
        if (s.current === s.grade) { res.unchanged.push(s); continue; }
        if (s.current !== '' && !this.overwrite) { res.kept.push(s); continue; }
        const r = this.doc.setGrade(s.id, s.grade);
        (r.ok ? res.applied : res.failed).push(r.ok ? s : Object.assign(s, { failure: r }));
      }
      return res;
    }
  }

  return { parseTable, guessMapping, buildEntries, ImportSession, normGrade, splitCombined, fold, candidatesFor, prepStudent, ROLES, _internal: { alternatives, scoreOne, normClass } };
});
