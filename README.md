# ENM-Noteneditor

A single-file web page for editing the **final grades** in SchILD-NRW "Externes Notenmodul"
files (`.enm`) on any device (Linux, iOS, Windows, macOS), including an **interactive table
import**: paste grades from Excel, Word, Markdown or CSV and match them to students with a
review step. Everything runs in the browser; files are never uploaded.

> Unofficial tool. Keep the original `.enm`, and test-import an edited file once before relying on it.

## For users

Open the published page (see below), click **Datei öffnen**, edit, **Speichern**.
Or download the single file `enm-editor.html` from the latest workflow run
(*Actions → latest run → Artifacts → enm-editor*) and open it by double-click: it needs no
internet connection and no other files.

### Importing a table of grades

1. **Tabelle importieren…** → paste a table (or a single column like `Mara F 2+`: first name,
   last-name initial if first names repeat, grade).
2. **Pick the subject** (and class) the grades belong to; check the detected column roles.
3. **Review:** exact full names are accepted automatically; shorthand (`Mara`, `Mara F`) is
   proposed and needs your *Confirm*; ambiguous, unknown or misspelled names need a decision;
   invalid grades and duplicate students block the import. Existing grades are kept unless you
   tick *overwrite*.
4. **Apply** (enabled only when nothing is open). The grades become normal pending edits
   (yellow rows) that you can still change before saving.

## Setup on GitHub (once)

1. Create a repository and upload the contents of this folder to the **root**
   (the `.github` folder must be at the top level), e.g.

   ```
   git init -b main && git add . && git commit -m "Initial commit"
   git remote add origin https://github.com/<you>/<repo>.git && git push -u origin main
   ```
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. Push to `main`. The workflow **Build and deploy** (`.github/workflows/pages.yml`) runs the
   tests, builds `dist/index.html`, uploads `enm-editor.html` as a downloadable artifact and
   publishes the page at `https://<you>.github.io/<repo>/`.

The footer of the published page shows the build date and commit.

## Develop

```
npm test          # fixture-free unit tests (this is what CI runs)
npm run build     # src/ -> dist/index.html (one self-contained file)
```

- `src/index.html` page and UI, `src/enm.js` read/write the file format, `src/import.js` table import and matching.
- The build inlines both scripts into one HTML file (`scripts/build.mjs`).
- Regression tests against real files (local only, never commit them):
  `ENM_UNCHANGED=a.enm ENM_OFFICIAL=a-edited-by-official-tool.enm npm run test:sample`

## How saving works

An `.enm` is a Microsoft Jet 4 (Access 2000/2003) database whose pages are RC4-scrambled with a
key stored in its own header. The tool does **not** regenerate the database: it rewrites only the
edited rows inside their original data page (grade, points, "modified" flag), re-scrambles that
page, bumps the small change counter in the header, and re-opens its own output to check that
everything else is unchanged. For the same edits, the output was byte-identical to the file saved
by the official Windows tool.

## Limits (v0.2)

- Only final grades (`NotenKrz`/`Punkte`); not partial grades, absences, warnings or texts.
- **Page capacity:** each data page has only a few dozen spare bytes and filling an empty grade
  costs 4-8 bytes. If edits no longer fit, the edit is refused (never a risky file) and, during an
  import, reported. Jet's "row overflow" mechanism is not implemented yet.
- Not yet verified against a real SchILD import.
- Jet 4 files only; rows already moved by an overflow are shown but locked.
- `.xlsx` files cannot be loaded directly (copy the cells from Excel instead).

## Privacy

`.enm` files contain student names and grades. `.gitignore` excludes them; keep them out of the repo.
