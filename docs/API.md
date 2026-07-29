# Spendy server API — contract v1

The app is **server-authoritative**: the browser keeps no persistent store (no IndexedDB, no
`spendy-db.js`, no File System Access sync). Every read and write goes to this API. SQLite on the
server is the single source of truth.

- **Runtime:** Python 3.11+ **standard library only** (no pip installs). Must run on `python:3.12-slim`.
- **Auth:** none. Intended for LAN / VPN only. Bind address is configurable so it can be kept off the internet.
- **Transport:** HTTP/1.1, JSON bodies, UTF-8. `Access-Control-Allow-Origin: *` on every response and
  a working `OPTIONS` preflight, so the page also works when opened from another origin during development.

## Environment

| Var | Default | Meaning |
|---|---|---|
| `SPENDY_DATA` | `/data` | directory holding `spendy.db`, `images/`, `tmp/` |
| `SPENDY_APP_DIR` | directory containing `Spendy.html` | static files to serve |
| `SPENDY_HOST` | `0.0.0.0` | bind address |
| `SPENDY_PORT` | `8765` | port |

Nothing personal is ever written inside `SPENDY_APP_DIR`. `SPENDY_DATA` is the only writable location
and is mounted as a Docker volume, so the git repo never contains user data.

## Storage

```sql
CREATE TABLE records (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL DEFAULT '',
  amount       REAL    NOT NULL DEFAULT 0,
  type         TEXT    NOT NULL DEFAULT 'expense',   -- expense | income | invest | debt
  category     TEXT    NOT NULL DEFAULT '',
  method       TEXT    NOT NULL DEFAULT '',
  date         INTEGER,                              -- epoch ms of local midnight, or NULL
  dateStr      TEXT    NOT NULL DEFAULT '',          -- YYYY-MM-DD, local calendar day
  monthKey     TEXT    NOT NULL DEFAULT 'Unknown',   -- YYYY-MM
  monthLabel   TEXT    NOT NULL DEFAULT 'Unknown',
  fingerprint  TEXT    NOT NULL,                     -- name|amount|category|dateStr
  image        TEXT,                                 -- 64-hex content hash, or NULL
  installments INTEGER                               -- N>=2, or NULL
);
CREATE UNIQUE INDEX idx_records_fp ON records(fingerprint);

CREATE TABLE meta   (key TEXT PRIMARY KEY, value TEXT NOT NULL);  -- value = JSON text
CREATE TABLE images (hash TEXT PRIMARY KEY, mime TEXT NOT NULL, ext TEXT NOT NULL,
                     bytes INTEGER NOT NULL, created INTEGER NOT NULL);
```

`fingerprint` uniqueness replaces the IndexedDB unique index and is the ONLY dedup mechanism.
The client computes it; the server never recomputes it.

Image bytes live at `$SPENDY_DATA/images/<hash[0:2]>/<hash>.<ext>`, addressed by SHA-256 of the raw
bytes, so identical attachments are stored once. Deleting a record never deletes image bytes.

`PRAGMA journal_mode=WAL`. One connection per request; every write path holds a single process-wide
`threading.Lock`, so `ThreadingHTTPServer` can serve reads concurrently without write races.

## Record JSON

Wire shape, both directions:

```json
{ "id": 12, "name": "Cà phê", "amount": 45000, "type": "expense", "category": "Coffee",
  "method": "Credit Card", "date": 1753632000000, "dateStr": "2026-07-28",
  "monthKey": "2026-07", "monthLabel": "July 2026",
  "fingerprint": "Cà phê|45000|Coffee|2026-07-28", "image": null, "installments": null }
```

Unknown keys are ignored on write. `id` is assigned by SQLite and is stable — the client uses it as
its row identity everywhere (`window.editRow(id)`, `ccTick(id)`, `fixCat(id)`).

**Image normalization (applies to every record write, on every endpoint):** if `image` is a
`data:<mime>;base64,…` URL, the server decodes it, stores the bytes, and replaces the field with the
hash before insert. If it is already a 64-hex hash it is kept as-is. Anything else becomes `NULL`.
This one rule makes the edit modal, CSV import, restore of an old backup, and the migration script all
work without the client knowing how images are stored.

## Endpoints

### `GET /api/state`
The single startup read. Returns everything the app needs to boot.
```json
{ "ok": true, "records": [ … ], "meta": { "budgets": {…}, "cards": […], … } }
```
`meta` values are already JSON-decoded. Absent keys are simply absent.

### `GET /api/fingerprints`
`{ "ok": true, "fingerprints": ["…", …] }` — lets the client preview "N new · M duplicates" before
committing an import or restore, exactly as it does today.

### `POST /api/records`
Body: one record without `id`. → `201 {ok, record}` with the assigned `id`.
Duplicate fingerprint → `409 {ok:false, error:"duplicate", id:<existing id>}`.

### `PUT /api/records/<id>`
Body: the full record. → `{ok, record}`. Fingerprint colliding with a **different** row → `409`.
Missing row → `404`.

### `DELETE /api/records/<id>` → `{ok, deleted: 0|1}`

### `POST /api/records/bulk`
The one transactional write used by CSV import, restore-commit, and the legacy-installment merge.
```json
{ "add": [ …records… ], "deleteIds": [ 4, 5 ] }
```
Deletes run first, then inserts. A row whose fingerprint already exists is **skipped, not an error**
(this mirrors the old swallow-`ConstraintError` behaviour). Any other failure rolls the whole
transaction back — partial writes are never committed.
→ `{ok, added, duplicates, deleted, records: [ …inserted rows with ids… ]}`

`replaceAll` is the third, mutually exclusive mode:
```json
{ "replaceAll": [ …records, each WITH its id… ] }
```
In one transaction: delete every row, then insert exactly the given rows preserving their ids.
This is what a category rename/merge needs — it rewrites the fingerprint of many rows at once, and a
row-by-row update would transiently violate the unique index. → `{ok, replaced}`.

### `DELETE /api/records?meta=1`
Wipe. Always clears `records`; also clears `meta` when `meta=1`. → `{ok, deleted}`.
Image files are left on disk (recover them with the GC endpoint).

### `GET /api/meta` → `{ok, meta:{…}}`
### `PUT /api/meta/<key>` — body `{"value": …}` → `{ok}`. `value: null` deletes the key.
### `PUT /api/meta` — body `{"meta": {key: value, …}}`, bulk overwrite → `{ok, written}`

### `GET /api/images/<hash>`
Raw bytes, correct `Content-Type`, `Cache-Control: public, max-age=31536000, immutable`
(content-addressed, so it can be cached forever). Unknown or malformed hash → `404`.
`<hash>` MUST match `^[0-9a-f]{64}$` — never build a path from unvalidated input.

### `POST /api/images`
Body `{"data": "data:image/png;base64,…"}` → `{ok, hash, url}`. Optional helper; record writes
normalize images on their own, so the client is not required to call this.

### `GET /api/backup.zip`
Self-contained portable backup — the answer to "backup must include card data too".
```
spendy-backup.json      ← identical shape to the app's old JSON backup
images/<hash>.<ext>     ← every image referenced by a record
```
`spendy-backup.json` is:
```json
{ "app": "spendy", "version": 1, "savedAt": 1753632000000,
  "records": [ …records without id, image = hash… ],
  "budgets": {}, "goal": 0, "catClass": {}, "incomeBase": 0, "cats": {}, "plans": [],
  "debts": [], "ccPaidFps": [], "ccPaidAt": {}, "ccNoteFps": {}, "catOk": [],
  "cards": [ …full card details… ], "pinnedCard": null }
```
Every meta key present in the DB is included, so **cards, pinned card, budgets, plans, paid ticks and
50/30/20 settings all round-trip**.

### `GET /api/backup.json`
The same JSON without the images (small, quick, still contains cards).

### `POST /api/restore/stage`
Upload of a `.zip` (as above) **or** a bare `.json` (current or legacy format, images as data-URLs or
hashes). Raw body, `Content-Type` ignored — sniff `PK\x03\x04` for zip. The file is staged in
`$SPENDY_DATA/tmp/`, nothing is written to the DB yet.
→ `{ok, token, total, fresh, duplicates, metaKeys:[…], records:<n>, images:<n>}`
so the client can render its existing confirmation summary.

### `POST /api/restore/commit`
Body `{"token": "…"}` → applies the staged file: records merge **additively** by fingerprint (existing
rows are never modified or deleted), meta keys present in the file overwrite, images are unpacked.
→ `{ok, added, duplicates, metaWritten}`. The staged file is deleted afterwards.
Staged files older than 1 hour are swept on each stage call.

Zip entries are validated before extraction: names must match `images/<64-hex>.<ext>` or be the single
JSON; absolute paths, `..`, and symlinks are rejected (no zip-slip).

### `POST /api/maintenance/gc-images`
Delete image files no record references. → `{ok, removed, freedBytes}`. No UI; run it by hand after a
big wipe.

### `GET /api/health`
`{ok, records, images, dbBytes, version}` — used by the client's connection pill and by the Docker
healthcheck.

## Static files

`GET /` serves `Spendy.html`. Any other path resolves inside `SPENDY_APP_DIR` after normalization;
requests escaping that directory, dotfiles, and non-whitelisted extensions
(`.html .js .css .png .svg .ico .woff2 .json .map`) are refused with `404`. `Cache-Control: no-cache`
on `Spendy.html` and `spendy.js` so a redeploy is picked up on reload.

`vendor/chart.umd.min.js` and `vendor/papaparse.min.js` are fetched at image-build time and served
locally, so the app works on a LAN with no internet access.

## Error contract

Non-2xx responses are always `{"ok": false, "error": "<machine-readable>", "detail": "<human>"}`.
The client surfaces failures with a toast and a red connection pill — a write that did not reach the
server must never look like it succeeded.
