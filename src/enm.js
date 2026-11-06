/*
 * enm.js - read and edit grades in SchILD-NRW "Externes Notenmodul" (.enm) files.
 *
 * An .enm file is a Microsoft Jet 4 (Access 2000/2003) database whose pages are
 * RC4-"encrypted" with a key stored in its own header (no password involved).
 * This module has no dependencies and runs in browsers and in Node.
 *
 * Writing strategy: never regenerate the database. Only the few bytes of the
 * rows that were edited are changed, inside their original data page, exactly
 * the way the official Windows tool does it (verified byte-for-byte against a
 * file produced by that tool). Everything else stays identical.
 *
 * Known limitation (v0.1): if the edited rows no longer fit into their page,
 * the edit is refused (reason "page-full"). Handling that needs the "row
 * overflow" mechanism of Jet; see README.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ENM = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PAGE = 4096;
  const HEADER_RC4_KEY = [0xC7, 0xDA, 0x39, 0x6B];
  const COUNTER_OFFSET = 3584; // 16-bit change counter in page 0 that the official tool bumps

  class EnmError extends Error {
    constructor(code, message, extra) {
      super(message);
      this.name = 'EnmError';
      this.code = code;
      if (extra) Object.assign(this, extra);
    }
  }

  // ---- small helpers -------------------------------------------------------
  const u16 = (b, o) => b[o] | (b[o + 1] << 8);
  const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const i16 = (b, o) => { const v = u16(b, o); return v & 0x8000 ? v - 0x10000 : v; };
  const i32 = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);

  function utf16le(b) {
    let s = '';
    for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(b[i] | (b[i + 1] << 8));
    return s;
  }
  function toUtf16le(s) {
    const o = new Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); o[2 * i] = c & 255; o[2 * i + 1] = c >> 8; }
    return o;
  }
  // Jet "Unicode compression": FF FE marker, then Latin-1 bytes; a 0x00 byte toggles to/from UTF-16 runs.
  function decodeText(v) {
    if (v.length >= 2 && v[0] === 0xFF && v[1] === 0xFE) {
      let s = '', comp = true, i = 2;
      while (i < v.length) {
        if (v[i] === 0) { comp = !comp; i++; continue; }
        if (comp) { s += String.fromCharCode(v[i]); i++; }
        else { s += String.fromCharCode(v[i] | (v[i + 1] << 8)); i += 2; }
      }
      return s;
    }
    return utf16le(v);
  }
  function concat(parts) {
    let n = 0; for (const p of parts) n += p.length;
    const out = new Uint8Array(n); let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  function eq(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // RC4 is symmetric: the same function encrypts and decrypts.
  function rc4(key, data) {
    const S = new Uint8Array(256);
    for (let i = 0; i < 256; i++) S[i] = i;
    let j = 0;
    for (let i = 0; i < 256; i++) {
      j = (j + S[i] + key[i % key.length]) & 255;
      const t = S[i]; S[i] = S[j]; S[j] = t;
    }
    const out = new Uint8Array(data.length);
    let a = 0, b = 0;
    for (let k = 0; k < data.length; k++) {
      a = (a + 1) & 255; b = (b + S[a]) & 255;
      const t = S[a]; S[a] = S[b]; S[b] = t;
      out[k] = data[k] ^ S[(S[a] + S[b]) & 255];
    }
    return out;
  }

  // ---- table definition + rows --------------------------------------------
  function parseTdef(pg) {
    if (pg[0] !== 0x02) return null;
    const ncols = u16(pg, 0x2d), nreal = u32(pg, 0x33);
    if (ncols === 0 || ncols > 255 || nreal > 64) return null;
    let pos = 0x3f + 12 * nreal;
    if (pos + 25 * ncols > PAGE) return null;
    const cols = [];
    for (let i = 0; i < ncols; i++) {
      const d = pos + 25 * i;
      cols.push({ type: pg[d], num: u16(pg, d + 5), varIdx: u16(pg, d + 7), flags: pg[d + 15], fixedOff: u16(pg, d + 21), len: u16(pg, d + 23) });
    }
    pos += 25 * ncols;
    for (const c of cols) {
      if (pos + 2 > PAGE) return null;
      const len = u16(pg, pos);
      if (pos + 2 + len > PAGE) return null;
      c.name = utf16le(pg.subarray(pos + 2, pos + 2 + len));
      pos += 2 + len;
    }
    const byName = {};
    for (const c of cols) byName[c.name] = c;
    return { cols, byName, next: u32(pg, 4) };
  }

  function parseRow(r) {
    const n = r.length;
    const ncols = u16(r, 0), maskLen = (ncols + 7) >> 3;
    const posNv = n - maskLen - 2;
    const nv = u16(r, posNv);
    const offs = [];
    for (let i = 0; i <= nv; i++) offs.push(u16(r, posNv - 2 * (i + 1)));
    const vars = [];
    for (let i = 0; i < nv; i++) vars.push(r.subarray(offs[i], offs[i + 1]));
    return { ncols, fixed: r.subarray(2, offs[0]), vars, mask: r.slice(n - maskLen) };
  }
  function buildRow(p) {
    const head = new Uint8Array(2); head[0] = p.ncols & 255; head[1] = p.ncols >> 8;
    const offs = [];
    let pos = 2 + p.fixed.length;
    for (const v of p.vars) { offs.push(pos); pos += v.length; }
    offs.push(pos); // end-of-data marker
    const tail = new Uint8Array(2 * offs.length + 2);
    for (let i = 0; i < offs.length; i++) {
      const at = 2 * (offs.length - 1 - i); // entry i sits (i+1) slots before the var-count
      tail[at] = offs[i] & 255; tail[at + 1] = offs[i] >> 8;
    }
    tail[2 * offs.length] = p.vars.length & 255; tail[2 * offs.length + 1] = p.vars.length >> 8;
    return concat([head, p.fixed, ...p.vars, tail, p.mask]);
  }
  function setMaskBit(mask, bit, on) {
    const m = mask.slice();
    if (on) m[bit >> 3] |= 1 << (bit & 7); else m[bit >> 3] &= ~(1 << (bit & 7)) & 255;
    return m;
  }
  function readValue(col, p) {
    if (!col || col.num >= p.ncols) return null;
    const bit = (p.mask[col.num >> 3] >> (col.num & 7)) & 1;
    if (col.type === 1) return !!bit;           // boolean lives in the null mask
    if (!bit) return null;
    if (col.flags & 1) {                         // fixed-length
      const f = p.fixed, o = col.fixedOff;
      if (col.type === 2) return f[o];
      if (col.type === 3) return i16(f, o);
      if (col.type === 4) return i32(f, o);
      return undefined;
    }
    const v = p.vars[col.varIdx];
    if (!v) return null;
    if (col.type === 10) return decodeText(v);
    return v;
  }

  // ---- the document --------------------------------------------------------
  class EnmDocument {
    constructor(input) {
      const src = input instanceof Uint8Array ? input : new Uint8Array(input);
      this.raw = new Uint8Array(src.length); this.raw.set(src);
      const raw = this.raw;
      if (raw.length < PAGE * 4 || raw.length % PAGE !== 0) throw new EnmError('format', 'Not a valid database file (size).');
      let magic = ''; for (let i = 4; i < 19; i++) magic += String.fromCharCode(raw[i]);
      if (magic !== 'Standard Jet DB') throw new EnmError('format', 'Not a Jet/Access database (this tool supports SchILD-NRW .enm files).');
      if (raw[0x14] !== 1) throw new EnmError('version', 'Unsupported database version (only Jet 4 / Access 2000-2003 files are supported).');
      this.pageCount = raw.length / PAGE;
      const hdr = raw.slice(0, PAGE);
      hdr.set(rc4(HEADER_RC4_KEY, hdr.subarray(0x18, 0x18 + 126)), 0x18);
      this._key = hdr.slice(0x3e, 0x42);
      this._encrypted = this._key.some(b => b !== 0);
      this._cache = new Map();
      this._edits = new Map();
      this._load();
    }

    page(n) {
      let p = this._cache.get(n);
      if (p) return p;
      const raw = this.raw;
      p = raw.slice(n * PAGE, (n + 1) * PAGE);
      if (n > 0 && this._encrypted) {
        const k = [(n & 255) ^ this._key[0], ((n >> 8) & 255) ^ this._key[1], ((n >> 16) & 255) ^ this._key[2], ((n >>> 24) & 255) ^ this._key[3]];
        p = rc4(k, p);
      }
      this._cache.set(n, p);
      return p;
    }
    _encryptPage(n, plain) {
      if (!this._encrypted) return plain;
      const k = [(n & 255) ^ this._key[0], ((n >> 8) & 255) ^ this._key[1], ((n >> 16) & 255) ^ this._key[2], ((n >>> 24) & 255) ^ this._key[3]];
      return rc4(k, plain);
    }
    _entries(pg) {
      const cnt = u16(pg, 12), out = [];
      let prev = PAGE;
      for (let i = 0; i < cnt; i++) {
        const o = u16(pg, 14 + 2 * i), start = o & 0x1FFF;
        out.push({ idx: i, flags: o & 0xE000, start, end: prev });
        prev = start;
      }
      return out;
    }

    _load() {
      // locate tables by their column names (the schema of ENM files is fixed)
      const tdefs = {}, owners = {};
      for (let n = 1; n < this.pageCount; n++) {
        const pg = this.page(n);
        if (pg[0] === 0x02) {
          let t = null; try { t = parseTdef(pg); } catch (e) { /* ignore */ }
          if (!t) continue;
          if (t.byName.NotenKrz && t.byName.S_GUID && t.byName.Modifiziert && t.byName.FachBez) tdefs.leistung = { page: n, def: t };
          else if (t.byName.Krz && t.byName.Zeugnisnotenbez && t.byName.Punkte && t.byName.Sichtbar) tdefs.noten = { page: n, def: t };
        } else if (pg[0] === 0x01) {
          const o = u32(pg, 4); (owners[o] = owners[o] || []).push(n);
        }
      }
      if (!tdefs.leistung) throw new EnmError('schema', 'This file does not contain the grade table (SchuelerLeistungsDaten). Is it really an .enm file?');
      if (!tdefs.noten) throw new EnmError('schema', 'This file does not contain the grade scale table (Noten).');
      for (const k of ['leistung', 'noten']) {
        if (tdefs[k].def.next !== 0) throw new EnmError('schema', 'Table definition spans several pages (not supported).');
      }
      this._def = tdefs.leistung.def;
      this._dataPages = owners[tdefs.leistung.page] || [];

      // grade scale
      const nd = tdefs.noten.def;
      this.grades = this._readTable(tdefs.noten, owners).map(({ p }) => ({
        krz: readValue(nd.byName.Krz, p) || '', art: readValue(nd.byName.Art, p) || '',
        text: readValue(nd.byName.Bezeichnung, p) || '', punkte: readValue(nd.byName.Punkte, p) || '',
        sort: readValue(nd.byName.Sortierung, p) || 0, visible: readValue(nd.byName.Sichtbar, p) === '+',
      })).filter(g => g.visible && g.krz !== '').sort((a, b) => a.sort - b.sort);
      this._gradeByKrz = new Map(this.grades.map(g => [g.krz, g]));

      // students / grade rows
      const d = this._def.byName;
      this.rows = [];
      this._pageInfo = new Map();
      let roundtripOk = true;
      for (const r of this._readTable(tdefs.leistung, owners)) {
        const p = r.p;
        const row = {
          id: r.page + ':' + r.idx, page: r.page, idx: r.idx, locked: r.locked,
          guid: readValue(d.S_GUID, p), name: readValue(d.Name, p) || '', klasse: readValue(d.Klasse, p) || '',
          jahrgang: readValue(d.ASDJahrgang, p) || '', fach: readValue(d.FachBez, p) || '', kursart: readValue(d.KursartKrz, p) || '',
          krz: readValue(d.NotenKrz, p) || '', punkte: readValue(d.Punkte, p), modified: readValue(d.Modifiziert, p) === true,
          _bytes: r.bytes, _p: p,
        };
        row.origKrz = row.krz; row.origPunkte = row.punkte;
        if (!row.locked && !eq(buildRow(parseRow(r.bytes)), r.bytes)) roundtripOk = false;
        this.rows.push(row);
      }
      this.readOnly = !roundtripOk;
      if (this.readOnly) this.readOnlyReason = 'Row layout not understood; opened read-only to protect your file.';
      this._rowById = new Map(this.rows.map(r => [r.id, r]));
    }

    _readTable(t, owners) {
      const pages = owners[t.page] || [], out = [], targets = new Set();
      for (const n of pages) { // pass 1: find overflow pointers
        const pg = this.page(n);
        for (const e of this._entries(pg)) {
          if ((e.flags & 0x4000) && e.end - e.start >= 4) targets.add((pg[e.start + 1] | (pg[e.start + 2] << 8) | (pg[e.start + 3] << 16)) + ':' + pg[e.start]);
        }
      }
      for (const n of pages) {
        const pg = this.page(n);
        for (const e of this._entries(pg)) {
          if ((e.flags & 0x8000) && !(e.flags & 0x4000)) continue;        // deleted
          if (targets.has(n + ':' + e.idx)) continue;                      // overflow destination: reached via its pointer
          let bytes, locked = false;
          if (e.flags & 0x4000) {                                          // overflow pointer
            const tp = pg[e.start + 1] | (pg[e.start + 2] << 8) | (pg[e.start + 3] << 16), tr = pg[e.start];
            const tpg = this.page(tp), te = this._entries(tpg)[tr];
            if (!te) continue;
            bytes = tpg.subarray(te.start, te.end); locked = true;
          } else bytes = pg.subarray(e.start, e.end);
          let p; try { p = parseRow(bytes); } catch (err) { continue; }
          out.push({ page: n, idx: e.idx, bytes, p, locked });
        }
      }
      return out;
    }

    // ---- editing -----------------------------------------------------------
    gradeInfo(krz) { return this._gradeByKrz.get(krz); }
    get changeCount() { return this._edits.size; }
    isEdited(id) { return this._edits.has(id); }

    _editedBytes(row, krz, punkte) {
      const d = this._def.byName, p = parseRow(row._bytes);
      const vars = p.vars.slice();
      vars[d.NotenKrz.varIdx] = toUtf16le(krz);
      vars[d.Punkte.varIdx] = toUtf16le(punkte);
      let mask = p.mask;
      mask = setMaskBit(mask, d.NotenKrz.num, true);
      mask = setMaskBit(mask, d.Punkte.num, true);
      mask = setMaskBit(mask, d.Modifiziert.num, true);
      return buildRow({ ncols: p.ncols, fixed: p.fixed, vars, mask });
    }
    pageFree(n) { return u16(this.page(n), 2); }
    _pageDelta(n) {
      let delta = 0;
      for (const [id, e] of this._edits) { const r = this._rowById.get(id); if (r.page === n) delta += e.bytes.length - r._bytes.length; }
      return delta;
    }

    /** Set the grade of a row ('' clears it). Returns {ok:true} or {ok:false, reason}. */
    setGrade(id, krz) {
      const row = this._rowById.get(id);
      if (!row) return { ok: false, reason: 'unknown-row' };
      if (this.readOnly) return { ok: false, reason: 'read-only' };
      if (row.locked) return { ok: false, reason: 'locked' };
      let punkte = '';
      if (krz !== '') {
        const g = this._gradeByKrz.get(krz);
        if (!g) return { ok: false, reason: 'unknown-grade' };
        punkte = g.punkte;
      }
      const previous = this._edits.get(id);
      if (krz === row.origKrz) {                      // back to the original value: no edit
        this._edits.delete(id);
        row.krz = row.origKrz; row.punkte = row.origPunkte;
        return { ok: true };
      }
      this._edits.set(id, { krz, punkte, bytes: this._editedBytes(row, krz, punkte) });
      const delta = this._pageDelta(row.page), free = this.pageFree(row.page);
      if (delta > free) {                             // would not fit into the page: undo
        if (previous) this._edits.set(id, previous); else this._edits.delete(id);
        return { ok: false, reason: 'page-full', need: delta, free };
      }
      row.krz = krz; row.punkte = punkte;
      return { ok: true };
    }
    discardAll() {
      for (const id of this._edits.keys()) { const r = this._rowById.get(id); r.krz = r.origKrz; r.punkte = r.origPunkte; }
      this._edits.clear();
    }

    /** Build the edited file. Throws if its own verification fails. */
    save() {
      if (this.readOnly) throw new EnmError('read-only', this.readOnlyReason);
      const out = this.raw.slice();
      const touched = new Set();
      const byPage = new Map();
      for (const [id, e] of this._edits) {
        const r = this._rowById.get(id);
        if (!byPage.has(r.page)) byPage.set(r.page, new Map());
        byPage.get(r.page).set(r.idx, e.bytes);
      }
      for (const [n, repl] of byPage) {
        const pg = this.page(n), entries = this._entries(pg);
        const np = pg.slice();
        const hdrEnd = 14 + 2 * entries.length;
        np.fill(0, hdrEnd, PAGE);
        let pos = PAGE;
        for (const e of entries) {
          const bytes = repl.get(e.idx) || pg.subarray(e.start, e.end);
          pos -= bytes.length;
          if (pos < hdrEnd) throw new EnmError('page-full', 'Edited rows do not fit into their page.', { page: n });
          np.set(bytes, pos);
          const off = pos | e.flags;
          np[14 + 2 * e.idx] = off & 255; np[15 + 2 * e.idx] = off >> 8;
        }
        const free = pos - hdrEnd;
        np[2] = free & 255; np[3] = free >> 8;
        out.set(this._encryptPage(n, np), n * PAGE);
        touched.add(n);
      }
      const c = (u16(out, COUNTER_OFFSET) + this._edits.size) & 0xFFFF;
      out[COUNTER_OFFSET] = c & 255; out[COUNTER_OFFSET + 1] = c >> 8;
      this._verify(out, touched);
      return out;
    }

    _verify(out, touched) {
      const fail = (m) => { throw new EnmError('verify', 'Self-check failed, nothing was saved: ' + m); };
      if (out.length !== this.raw.length) fail('file size changed');
      for (let n = 1; n < this.pageCount; n++) {
        if (touched.has(n)) continue;
        for (let i = n * PAGE; i < (n + 1) * PAGE; i++) if (out[i] !== this.raw[i]) fail('untouched page ' + n + ' differs');
      }
      for (let i = 0; i < PAGE; i++) if ((i < COUNTER_OFFSET || i > COUNTER_OFFSET + 1) && out[i] !== this.raw[i]) fail('header differs at ' + i);
      let again; try { again = new EnmDocument(out); } catch (e) { fail('result cannot be read again (' + e.message + ')'); }
      if (again.rows.length !== this.rows.length) fail('row count changed');
      for (let i = 0; i < this.rows.length; i++) {
        const a = this.rows[i], b = again.rows[i], ed = this._edits.get(a.id);
        const wantKrz = ed ? ed.krz : a.origKrz, wantP = ed ? ed.punkte : a.origPunkte;
        if (b.id !== a.id || b.guid !== a.guid || b.name !== a.name || b.klasse !== a.klasse || b.fach !== a.fach) fail('identity of row ' + a.id + ' changed');
        if (b.krz !== wantKrz || b.punkte !== wantP) fail('grade of row ' + a.id + ' is wrong');
        if (ed ? b.modified !== true : b.modified !== a.modified) fail('modified flag of row ' + a.id);
        if (!ed && !eq(b._bytes, a._bytes)) fail('untouched row ' + a.id + ' differs');
      }
    }
  }

  return { open: (buf) => new EnmDocument(buf), EnmDocument, EnmError, _internal: { rc4, parseRow, buildRow, decodeText } };
});
