#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Spendy one-time migration: folder-database / JSON backup  ->  server SQLite.

    python migrate.py <file> [--data DIR] [--dry-run] [--force]

<file> is auto-detected as either

  1. spendy-db.js   -- `window.__SPENDY_DB__=JSON.parse("<double-stringified payload>");`
                       (the app's "Save to Drive" folder database, ~61 MB, non-ASCII escaped)
  2. spendy-backup-YYYY-MM-DD.json -- the same payload as bare JSON.

Both carry the backup shape documented in docs/API.md:
    { app, version, [savedAt,] records:[...], budgets, goal, catClass, incomeBase,
      cats, plans, debts, ccPaidFps, ccPaidAt, ccNoteFps, catOk, cards, pinnedCard }

Design rules that are NOT negotiable (see docs/API.md and CLAUDE.md):

  * Standard library only. Runs unchanged on python:3.12-slim.
  * Everything written lives under $SPENDY_DATA. Nothing is written into the repo.
  * DATES ARE LOCAL CALENDAR DAYS. dateStr / monthKey / monthLabel are copied VERBATIM and are
    never re-derived from the `date` timestamp -- doing so shifts every Vietnamese (UTC+7)
    transaction back one day. The only conversion applied to `date` is a representation change
    (ISO-8601 instant -> epoch milliseconds) because the column is INTEGER; the instant is
    preserved exactly, by integer timedelta arithmetic, never by float seconds.
  * fingerprint = name|amount|category|dateStr, computed by the CLIENT and UNIQUE in SQL.
    It is copied verbatim and only recomputed when a record has none. A duplicate is SKIPPED
    silently -- never an error, never an abort.
  * UTF-8 everywhere: Vietnamese text (đ, ế, ộ) must round-trip byte-exact.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import json
import os
import re
import sqlite3
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Windows consoles default to cp1252 and would explode on the first Vietnamese category name.
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


# --------------------------------------------------------------------------------------
# Schema -- owned by app.py, imported so the two can never drift.
# --------------------------------------------------------------------------------------

# Used ONLY when server/app.py is absent or exposes no recognisable schema. Copied verbatim
# from docs/API.md except for the added IF NOT EXISTS (which makes it re-runnable and cannot
# change the resulting shape). Its use is announced loudly on stderr.
FALLBACK_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS records (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL DEFAULT '',
  amount       REAL    NOT NULL DEFAULT 0,
  type         TEXT    NOT NULL DEFAULT 'expense',
  category     TEXT    NOT NULL DEFAULT '',
  method       TEXT    NOT NULL DEFAULT '',
  date         INTEGER,
  dateStr      TEXT    NOT NULL DEFAULT '',
  monthKey     TEXT    NOT NULL DEFAULT 'Unknown',
  monthLabel   TEXT    NOT NULL DEFAULT 'Unknown',
  fingerprint  TEXT    NOT NULL,
  image        TEXT,
  installments INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_records_fp ON records(fingerprint);

CREATE TABLE IF NOT EXISTS meta   (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS images (hash TEXT PRIMARY KEY, mime TEXT NOT NULL, ext TEXT NOT NULL,
                                   bytes INTEGER NOT NULL, created INTEGER NOT NULL);
"""

_SQL_ATTRS = ("SCHEMA_SQL", "SCHEMA", "SCHEMA_DDL", "DDL", "CREATE_SQL", "INIT_SQL")
_SEQ_ATTRS = ("SCHEMA_STATEMENTS", "SCHEMA_SQL", "SCHEMA", "DDL_STATEMENTS")
_FN_ATTRS = ("init_db", "ensure_schema", "init_schema", "create_schema", "setup_db", "migrate_db")

REQUIRED_TABLES = ("records", "meta", "images")


def import_app(data_dir: Path):
    """Import server/app.py.

    $SPENDY_DATA is exported FIRST because app.py resolves DATA_DIR/DB_PATH at module import
    time; without this, app.init_db() would happily create /data/spendy.db instead of the
    database this run was asked for.
    """
    os.environ["SPENDY_DATA"] = str(data_dir.resolve())
    here = str(Path(__file__).resolve().parent)
    if here not in sys.path:
        sys.path.insert(0, here)
    try:
        import app  # type: ignore
        return app
    except ImportError:
        return None
    except Exception as e:  # app.py exists but blew up at import -- say so, never hide it
        warn("server/app.py could not be imported (%s: %s); falling back to the DDL in docs/API.md"
             % (type(e).__name__, e))
        return None


def _same_file(a, b) -> bool:
    """Do two (possibly non-existent) paths name the same file? Case-insensitive on Windows."""
    norm = lambda p: os.path.normcase(os.path.realpath(os.path.abspath(str(p))))
    return norm(a) == norm(b)


def _tables(conn) -> set:
    return {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}


def _has_fp_unique(conn) -> bool:
    """True when records.fingerprint carries a UNIQUE index -- the dedup guarantee itself."""
    for _seq, name, uniq, *_rest in conn.execute("PRAGMA index_list(records)"):
        if not uniq:
            continue
        cols = [c[2] for c in conn.execute('PRAGMA index_info("%s")' % name.replace('"', '""'))]
        if cols == ["fingerprint"]:
            return True
    return False


def build_schema(data_dir: Path, db_path: Path) -> str:
    """Create/upgrade the database using app.py's own DDL. Returns where it came from.

    app.py is the owner of the schema; this never duplicates it unless app.py is absent.
    """
    app = import_app(data_dir)
    if app is None:
        warn("server/app.py not found -- applying the schema from docs/API.md instead. "
             "Re-run once app.py exists if its DDL ever differs.")
        conn = sqlite3.connect(str(db_path))
        try:
            conn.executescript(FALLBACK_SCHEMA_SQL)
            conn.commit()
        finally:
            conn.close()
        return "docs/API.md (fallback -- app.py absent)"

    # 1. Preferred: app.py's own initialiser, which also makes images/ and tmp/ and the index.
    app_db = getattr(app, "DB_PATH", None)
    # normcase+realpath: on Windows Path.resolve() restores the on-disk letter case, so a plain
    # string compare against an abspath of the same file can disagree on nothing but case.
    same_db = app_db is not None and _same_file(app_db, db_path)
    for attr in _FN_ATTRS:
        fn = getattr(app, attr, None)
        if not callable(fn):
            continue
        if not same_db:
            # Refuse to call an initialiser that would write somewhere else entirely.
            warn("app.%s() targets %s, not %s -- not calling it." % (attr, app_db, db_path))
            break
        try:
            fn()
        except TypeError:
            continue          # different signature: fall through to the raw DDL below
        except Exception as e:
            warn("app.%s() failed (%s: %s); falling back to app.py's raw DDL."
                 % (attr, type(e).__name__, e))
            break
        return "app.%s()" % attr

    # 2. Otherwise run app.py's DDL constants ourselves.
    for attr in _SEQ_ATTRS:
        val = getattr(app, attr, None)
        stmts = None
        if isinstance(val, str) and "CREATE TABLE" in val.upper():
            stmts = [val]
        elif isinstance(val, (tuple, list)) and val and all(isinstance(s, str) for s in val):
            stmts = list(val)
        if not stmts:
            continue
        conn = sqlite3.connect(str(db_path))
        try:
            for s in stmts:
                conn.executescript(s)
            conn.commit()
        finally:
            conn.close()
        return "app.%s" % attr

    warn("server/app.py exposes no recognisable schema (looked for %s, or %s) -- "
         "applying the DDL from docs/API.md."
         % (", ".join(a + "()" for a in _FN_ATTRS), ", ".join(_SEQ_ATTRS)))
    conn = sqlite3.connect(str(db_path))
    try:
        conn.executescript(FALLBACK_SCHEMA_SQL)
        conn.commit()
    finally:
        conn.close()
    return "docs/API.md (fallback)"


def verify_schema(conn, origin: str, writable: bool) -> None:
    """Whatever built the schema, the parts this migration depends on must actually be there.

    The UNIQUE index on fingerprint is not cosmetic: it is the second line of defence behind
    the in-Python dedup, and the contract's only dedup mechanism.
    """
    missing = [t for t in REQUIRED_TABLES if t not in _tables(conn)]
    if missing:
        if not writable:
            die("database is missing table(s) %s" % ", ".join(missing))
        warn("schema source (%s) did not create %s; applying the DDL from docs/API.md."
             % (origin, ", ".join(missing)))
        conn.executescript(FALLBACK_SCHEMA_SQL)
        conn.commit()
        still = [t for t in REQUIRED_TABLES if t not in _tables(conn)]
        if still:
            die("schema is still incomplete; missing table(s): %s" % ", ".join(still))

    if not _has_fp_unique(conn):
        if not writable:
            warn("records.fingerprint has NO unique index in this database.")
            return
        warn("schema source (%s) left records.fingerprint without a UNIQUE index -- "
             "creating idx_records_fp, dedup depends on it." % origin)
        try:
            conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_records_fp "
                         "ON records(fingerprint)")
            conn.commit()
        except sqlite3.DatabaseError as e:
            die("could not create the unique index on records.fingerprint: %s\n"
                "       The database already holds duplicate fingerprints; clean them up "
                "before migrating." % e)


# --------------------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------------------

def out(msg=""):
    print(msg, flush=True)


def warn(msg):
    print("  !  " + msg, file=sys.stderr, flush=True)


def die(msg, code=2):
    print("\nERROR: " + msg, file=sys.stderr, flush=True)
    raise SystemExit(code)


def human(n: int) -> str:
    f = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if f < 1024 or unit == "GB":
            return ("%.0f %s" % (f, unit)) if unit == "B" else ("%.1f %s" % (f, unit))
        f /= 1024.0
    return "%d B" % n


def js_number(x) -> str:
    """Format a number the way JavaScript's String(n) does -- the fingerprint depends on it.

    JS prints 15000 for 15000.0 and 45000.5 for 45000.5. Python's str(float) would emit
    '15000.0' and break every recomputed fingerprint.
    """
    try:
        f = float(x)
    except (TypeError, ValueError):
        return "0"
    if f != f or f in (float("inf"), float("-inf")):
        return "0"
    if f == int(f) and abs(f) < 1e16:
        return str(int(f))
    return repr(f)


MONTHS = ("January", "February", "March", "April", "May", "June",
          "July", "August", "September", "October", "November", "December")
DATESTR_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
HEX64_RE = re.compile(r"^[0-9a-f]{64}$")
EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


def to_epoch_ms(v):
    """`date` -> epoch milliseconds (INTEGER column), or None.

    This converts a REPRESENTATION (ISO-8601 instant -> ms since epoch); it never touches, reads
    or produces a calendar day. dateStr/monthKey/monthLabel are copied verbatim elsewhere and are
    NEVER derived from this value.
    """
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v
    if isinstance(v, float):
        return int(round(v))
    s = str(v).strip()
    if not s:
        return None
    if s.lstrip("-").isdigit():
        return int(s)
    iso = s[:-1] + "+00:00" if s.endswith(("Z", "z")) else s
    try:
        dt = datetime.fromisoformat(iso)
    except ValueError:
        return None
    if dt.tzinfo is None:
        # JSON.stringify(new Date()) always emits a Z suffix, so this branch is defensive only.
        dt = dt.replace(tzinfo=timezone.utc)
    # Integer arithmetic: dt.timestamp()*1000 loses the last millisecond to float rounding.
    return (dt - EPOCH) // timedelta(milliseconds=1)


EXT_BY_MIME = {
    "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/pjpeg": "jpg",
    "image/gif": "gif", "image/webp": "webp", "image/avif": "avif", "image/bmp": "bmp",
    "image/heic": "heic", "image/heif": "heif", "image/tiff": "tiff",
    "image/svg+xml": "svg", "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico",
}


def parse_data_url(s: str):
    """'data:image/png;base64,AAA...' -> (mime, raw bytes). None if it is not one."""
    if not isinstance(s, str) or not s.startswith("data:"):
        return None
    head, sep, payload = s.partition(",")
    if not sep:
        return None
    meta = head[5:]
    if ";base64" not in meta.lower():
        return None  # plain (percent-encoded) data URLs are not produced by the app
    mime = (meta.split(";", 1)[0] or "application/octet-stream").strip().lower()
    try:
        raw = base64.b64decode(payload, validate=False)
    except (binascii.Error, ValueError):
        return None
    return (mime, raw) if raw else None


# --------------------------------------------------------------------------------------
# Loading the source file
# --------------------------------------------------------------------------------------

def sniff_kind(path: Path) -> str:
    """'json' or 'js', decided from the leading bytes only."""
    with open(path, "rb") as f:
        head = f.read(8192)
    if not head:
        die("%s is empty" % path)
    probe = head.lstrip(b"\xef\xbb\xbf").lstrip()
    if probe[:1] in (b"{", b"["):
        return "json"
    if b"__SPENDY_DB__" in head or probe[:2] == b"//" or probe[:6] == b"window":
        return "js"
    die("cannot tell what %s is -- expected a JSON backup or a spendy-db.js wrapper.\n"
        "       First bytes: %r" % (path, probe[:80]))


def load_payload(path: Path, kind: str) -> dict:
    """Parse either shape into the backup payload dict, without gratuitous 61 MB copies."""
    if kind == "json":
        with open(path, "rb") as f:
            raw = f.read()
        try:
            payload = json.loads(raw)  # bytes: json handles the BOM + UTF-8 detection itself
        except ValueError as e:
            die("%s is not valid JSON: %s" % (path.name, e))
        del raw
        return payload

    # spendy-db.js: one line, `window.__SPENDY_DB__=JSON.parse("<escaped JSON text>");`
    #
    # Read as BYTES and decode only from the payload onwards. Decoding the whole file would
    # include the comment line's em dash, and a single non-Latin-1 character promotes the entire
    # 61 MB str to UCS-2 (2 bytes/char) -- 123 MB for a 61 MB file, for one dash. The payload
    # region itself is pure ASCII (the app escapes every non-ASCII char as \uXXXX), so it decodes
    # to a compact 1-byte-per-char str.
    with open(path, "rb") as f:
        data = f.read()

    anchor = data.find(b"__SPENDY_DB__")
    if anchor < 0:
        anchor = 0
    dec = json.JSONDecoder()

    call = data.find(b"JSON.parse(", anchor)
    if call >= 0:
        i = call + len(b"JSON.parse(")
        while i < len(data) and data[i:i + 1] in (b" ", b"\t", b"\r", b"\n"):
            i += 1
        if data[i:i + 1] != b'"':
            die("malformed spendy-db.js: JSON.parse( is not followed by a string literal")
        try:
            tail = data[i:].decode("utf-8")
        except UnicodeDecodeError as e:
            die("spendy-db.js is not valid UTF-8: %s" % e)
        del data
        # raw_decode reads exactly one JSON value from index 0 and ignores the trailing `);`
        # -- no rfind heuristics, no regex over 61 MB, no second slice.
        try:
            inner, _ = dec.raw_decode(tail, 0)
        except ValueError as e:
            die("malformed spendy-db.js: could not read the JSON string literal (%s)" % e)
        del tail
        if not isinstance(inner, str):
            die("malformed spendy-db.js: JSON.parse() argument is not a string")
        try:
            payload = json.loads(inner)  # double-stringified: decode a second time
        except ValueError as e:
            die("malformed spendy-db.js: inner payload is not valid JSON (%s)" % e)
        del inner
        return payload

    # Older/hand-edited variant: window.__SPENDY_DB__={ ... };
    brace = data.find(b"{", anchor)
    if brace < 0:
        die("malformed spendy-db.js: found neither JSON.parse(\"...\") nor an object literal")
    try:
        tail = data[brace:].decode("utf-8")
    except UnicodeDecodeError as e:
        die("spendy-db.js is not valid UTF-8: %s" % e)
    del data
    try:
        payload, _ = dec.raw_decode(tail, 0)
    except ValueError as e:
        die("malformed spendy-db.js: object literal is not valid JSON (%s)" % e)
    del tail
    return payload


# --------------------------------------------------------------------------------------
# Record normalisation
# --------------------------------------------------------------------------------------

REC_FIELDS = ("name", "amount", "type", "category", "method", "date", "dateStr",
              "monthKey", "monthLabel", "fingerprint", "image", "installments")
VALID_TYPES = ("expense", "income", "invest", "debt")

# Top-level payload keys that are not meta.
NON_META = {"app", "version", "records", "savedAt"}
# Dead concepts under the server model -- deliberately not carried over.
DEAD_META = {"folderDbSaved", "syncHandle", "lastSyncedAt"}


def as_text(v) -> str:
    return "" if v is None else (v if isinstance(v, str) else str(v))


class Stats:
    def __init__(self):
        self.fp_computed = 0
        self.month_key_filled = 0
        self.month_label_filled = 0
        self.type_normalised = 0
        self.date_dropped = 0
        self.image_bad = 0
        self.image_hash_kept = 0


def normalise(r: dict, st: Stats) -> dict:
    """Backup record -> column values. Verbatim wherever the field exists."""
    date_str = as_text(r.get("dateStr"))

    month_key = r.get("monthKey")
    if month_key is None or month_key == "":
        # Derived from dateStr (a local calendar-day STRING), exactly as the client's makeRecord
        # does -- `mk = dateStr.slice(0,7)`. Never from the timestamp.
        month_key = date_str[:7] if DATESTR_RE.match(date_str) else "Unknown"
        st.month_key_filled += 1

    month_label = r.get("monthLabel")
    if month_label is None or month_label == "":
        if DATESTR_RE.match(date_str):
            month_label = "%s %s" % (MONTHS[int(date_str[5:7]) - 1], date_str[:4])
        else:
            month_label = "Unknown"
        st.month_label_filled += 1

    typ = r.get("type")
    if typ not in VALID_TYPES:
        # A record with no/unknown type is a legacy expense (client: isExpense()).
        if typ not in (None, ""):
            st.type_normalised += 1
        typ = "expense"

    try:
        amount = float(r.get("amount") or 0)
    except (TypeError, ValueError):
        amount = 0.0

    fp = r.get("fingerprint")
    if not isinstance(fp, str) or fp == "":
        fp = "%s|%s|%s|%s" % (as_text(r.get("name")), js_number(amount),
                              as_text(r.get("category")), date_str)
        st.fp_computed += 1

    raw_date = r.get("date")
    date_ms = to_epoch_ms(raw_date)
    if date_ms is None and raw_date not in (None, ""):
        st.date_dropped += 1

    inst = r.get("installments")
    try:
        inst = int(inst) if inst is not None and int(inst) >= 2 else None
    except (TypeError, ValueError):
        inst = None

    return {
        "name": as_text(r.get("name")),
        "amount": amount,
        "type": typ,
        "category": as_text(r.get("category")),
        "method": as_text(r.get("method")),
        "date": date_ms,
        "dateStr": date_str,
        "monthKey": as_text(month_key),
        "monthLabel": as_text(month_label),
        "fingerprint": fp,
        "image": None,          # filled in by the caller after the image is stored
        "installments": inst,
    }


# --------------------------------------------------------------------------------------
# Image store
# --------------------------------------------------------------------------------------

class ImageStore:
    """Content-addressed image tree: $SPENDY_DATA/images/<hash[:2]>/<hash>.<ext>

    Identical bytes hash identically, so an attachment shared by several records is decoded
    once per occurrence but written exactly once.
    """

    def __init__(self, root: Path, dry: bool):
        self.root = root
        self.dry = dry
        self.seen = {}          # hash -> (mime, ext, bytes) for every image met this run
        self.written = set()    # hashes whose bytes this run put on disk
        self.reused = set()     # hashes whose file was already there
        self.bytes_written = 0
        self.bytes_total = 0

    def put(self, mime: str, raw: bytes):
        """-> (hash, ext, nbytes, wrote_file). wrote_file is True only the first time."""
        h = hashlib.sha256(raw).hexdigest()
        self.bytes_total += len(raw)
        if h in self.seen:
            return (h,) + self.seen[h][1:] + (False,)

        ext = EXT_BY_MIME.get(mime, "bin")
        sub = self.root / h[:2]
        if sub.is_dir():
            for other in sorted(sub.glob(h + ".*")):
                if other.is_file() and not other.name.endswith(".part"):
                    ext = other.suffix.lstrip(".") or ext   # keep the ext already on disk
                    self.seen[h] = (mime, ext, len(raw))
                    self.reused.add(h)
                    return h, ext, len(raw), False

        if not self.dry:
            path = sub / ("%s.%s" % (h, ext))
            sub.mkdir(parents=True, exist_ok=True)
            tmp = path.with_name(path.name + ".part")
            with open(tmp, "wb") as f:
                f.write(raw)
            os.replace(tmp, path)          # atomic: a reader never sees a half-written image
        self.seen[h] = (mime, ext, len(raw))
        self.written.add(h)
        self.bytes_written += len(raw)
        return h, ext, len(raw), True


# --------------------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------------------

PROGRESS_EVERY = 100
COMMIT_EVERY = 200


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="migrate.py",
        description="Import a Spendy folder database (spendy-db.js) or JSON backup into the "
                    "server's SQLite database.")
    ap.add_argument("file", help="spendy-db.js or spendy-backup-YYYY-MM-DD.json")
    ap.add_argument("--data", default=os.environ.get("SPENDY_DATA", "/data"),
                    metavar="DIR", help="server data directory (default: $SPENDY_DATA or /data)")
    ap.add_argument("--dry-run", action="store_true",
                    help="report exactly what would happen; write nothing")
    ap.add_argument("--force", action="store_true",
                    help="proceed even if the database already holds records "
                         "(the import is still purely additive -- nothing is ever wiped)")
    args = ap.parse_args(argv)

    src = Path(args.file).expanduser()
    if not src.is_file():
        die("no such file: %s" % src)
    data_dir = Path(args.data).expanduser()
    db_path = data_dir / "spendy.db"
    images_dir = data_dir / "images"
    dry = args.dry_run
    t0 = time.time()

    out("Spendy migration")
    out("  source   : %s (%s)" % (src, human(src.stat().st_size)))
    out("  data dir : %s" % data_dir)
    out("  database : %s" % db_path)
    out("  mode     : %s" % ("DRY RUN -- nothing will be written" if dry else "write"))

    # Keep user data out of the repository.
    repo_root = Path(__file__).resolve().parent.parent
    try:
        data_dir.resolve().relative_to(repo_root)
        warn("the data directory is inside the repository (%s). $SPENDY_DATA should live "
             "outside it (or in a Docker volume) so user data never reaches git." % repo_root)
    except ValueError:
        pass

    # ---- read the source -------------------------------------------------------------
    kind = sniff_kind(src)
    out("\n[1/5] Parsing %s (detected: %s)..." % (src.name, "spendy-db.js wrapper" if kind == "js"
                                                  else "bare JSON backup"))
    payload = load_payload(src, kind)
    if not isinstance(payload, dict):
        die("payload is a %s, expected an object" % type(payload).__name__)
    records = payload.get("records")
    if records is None:
        die("payload has no 'records' key -- is this really a Spendy backup? keys: %s"
            % ", ".join(list(payload)[:12]))
    if not isinstance(records, list):
        die("'records' is a %s, expected a list" % type(records).__name__)
    saved_at = payload.get("savedAt")
    out("      app=%s version=%s%s -- %d record(s), %.1fs"
        % (payload.get("app"), payload.get("version"),
           (" savedAt=%s" % saved_at) if saved_at else "", len(records), time.time() - t0))

    meta_in = {k: v for k, v in payload.items() if k not in NON_META}
    skipped_meta = sorted(k for k in meta_in if k in DEAD_META)
    for k in skipped_meta:
        meta_in.pop(k, None)

    # ---- open the database -----------------------------------------------------------
    out("\n[2/5] Opening database...")
    db_exists = db_path.exists()
    if dry:
        if db_exists:
            # as_uri() percent-encodes spaces ("My Drive"); SQLite decodes %XX in URI filenames.
            conn = sqlite3.connect(db_path.resolve().as_uri() + "?mode=ro", uri=True)
            schema_origin = "existing database (opened read-only for the dry run)"
            if any(t not in _tables(conn) for t in REQUIRED_TABLES):
                conn.close()
                conn = sqlite3.connect(":memory:")
                conn.executescript(FALLBACK_SCHEMA_SQL)
                schema_origin = "scratch in-memory copy (database has no Spendy tables yet)"
        else:
            out("      %s does not exist; it would be created." % db_path)
            conn = sqlite3.connect(":memory:")
            conn.executescript(FALLBACK_SCHEMA_SQL)
            schema_origin = "scratch in-memory copy (dry run creates nothing on disk)"
        verify_schema(conn, schema_origin, writable=False)
    else:
        data_dir.mkdir(parents=True, exist_ok=True)
        images_dir.mkdir(parents=True, exist_ok=True)
        (data_dir / "tmp").mkdir(parents=True, exist_ok=True)
        schema_origin = build_schema(data_dir, db_path)
        conn = sqlite3.connect(str(db_path))
        conn.execute("PRAGMA journal_mode=WAL")
        verify_schema(conn, schema_origin, writable=True)
    conn.text_factory = str  # explicit: TEXT in and out as Python str (UTF-8)
    out("      schema source: %s" % schema_origin)

    existing_rows = conn.execute("SELECT COUNT(*) FROM records").fetchone()[0]
    out("      records already in database: %d" % existing_rows)
    if existing_rows and not args.force:
        if dry:
            warn("database already holds %d record(s): a real run would refuse without --force."
                 % existing_rows)
        else:
            conn.close()
            die("database already holds %d record(s).\n"
                "       Re-run with --force to merge additively (nothing is ever wiped),\n"
                "       or point --data at an empty directory." % existing_rows, code=3)

    # Which columns actually exist (survives an app.py schema that grows a column).
    rec_cols = [c[1] for c in conn.execute("PRAGMA table_info(records)")]
    cols = [f for f in REC_FIELDS if f in rec_cols]
    if "fingerprint" not in cols:
        conn.close()
        die("the records table has no 'fingerprint' column -- schema mismatch, refusing to run.")
    missing_cols = [f for f in REC_FIELDS if f not in rec_cols]
    if missing_cols:
        warn("records table is missing column(s) %s; those fields will be dropped."
             % ", ".join(missing_cols))
    insert_sql = 'INSERT OR IGNORE INTO records (%s) VALUES (%s)' % (
        ", ".join('"%s"' % c for c in cols), ", ".join("?" for _ in cols))

    existing_fps = {row[0] for row in conn.execute("SELECT fingerprint FROM records")}

    # ---- records ---------------------------------------------------------------------
    total = len(records)
    out("\n[3/5] Importing %d record(s)..." % total)
    store = ImageStore(images_dir, dry)
    st = Stats()
    added = dup_db = dup_file = 0
    with_images = 0
    seen_fps = set()
    img_rows = []       # (hash, mime, ext, bytes) -> images table
    img_seen = set()
    pending = 0

    for i in range(total):
        r = records[i]
        records[i] = None  # release each ~5 MB base64 dict as we go; peak stays near the payload
        if not isinstance(r, dict):
            continue

        row = normalise(r, st)
        fp = row["fingerprint"]

        # Dedup, the whole design. Silent skip -- never an error, never an abort.
        # seen_fps is tested first so a repeat inside this file is not blamed on the database.
        if fp in seen_fps:
            dup_file += 1
        elif fp in existing_fps:
            dup_db += 1
        else:
            img = r.get("image")
            if isinstance(img, str) and img:
                if HEX64_RE.match(img):
                    row["image"] = img          # already a content hash
                    st.image_hash_kept += 1
                    with_images += 1
                else:
                    parsed = parse_data_url(img)
                    if parsed is None:
                        st.image_bad += 1       # anything unrecognisable becomes NULL (API.md)
                    else:
                        mime, raw = parsed
                        h, ext, nbytes, wrote = store.put(mime, raw)
                        row["image"] = h
                        with_images += 1
                        if h not in img_seen:
                            img_seen.add(h)
                            img_rows.append((h, mime, ext, nbytes))
                            out("      %s image %s.%s  %s  (record %d: %s)"
                                % ("+" if wrote else "=", h[:12], ext, human(nbytes),
                                   i + 1, row["name"][:40]))
                        del raw
            if not dry:
                conn.execute(insert_sql, tuple(row[c] for c in cols))
            seen_fps.add(fp)
            existing_fps.add(fp)
            added += 1
            pending += 1
            if not dry and pending >= COMMIT_EVERY:
                conn.commit()
                pending = 0

        del r
        n = i + 1
        if n % PROGRESS_EVERY == 0 or n == total:
            out("      [%*d/%d] added %d · duplicate %d (%d in db, %d in file) · images %d · %.1fs"
                % (len(str(total)), n, total, added, dup_db + dup_file, dup_db, dup_file,
                   len(store.seen), time.time() - t0))

    if not dry:
        now_ms = int(time.time() * 1000)
        for h, mime, ext, nbytes in img_rows:
            conn.execute("INSERT OR IGNORE INTO images (hash, mime, ext, bytes, created) "
                         "VALUES (?,?,?,?,?)", (h, mime, ext, nbytes, now_ms))
        conn.commit()

    # ---- meta ------------------------------------------------------------------------
    out("\n[4/5] Writing meta...")
    written_meta = []
    for k in sorted(meta_in):
        v = meta_in[k]
        value = json.dumps(v, ensure_ascii=False)   # UTF-8, no \uXXXX mangling
        if not dry:
            conn.execute("INSERT INTO meta (key, value) VALUES (?,?) "
                         "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (k, value))
        written_meta.append(k)
        preview = value if len(value) <= 60 else value[:57] + "..."
        out("      %-18s %s" % (k, preview))
    if not dry:
        conn.commit()
    if skipped_meta:
        out("      skipped (dead under the server model): %s" % ", ".join(skipped_meta))
    if not written_meta:
        out("      (none in this file)")

    # ---- report ----------------------------------------------------------------------
    out("\n[5/5] Summary")
    final_rows = conn.execute("SELECT COUNT(*) FROM records").fetchone()[0]
    final_imgs = conn.execute("SELECT COUNT(*) FROM images").fetchone()[0]
    conn.commit()
    conn.close()

    # Invariant: every record this run counted as added must actually be a row now. Dedup is a
    # deliberate silent skip, but INSERT OR IGNORE would also swallow, say, a NOT NULL violation
    # from a schema that grew a column -- that would be silent data loss, so it gets shouted about.
    if not dry and final_rows - existing_rows != added:
        warn("ROW COUNT MISMATCH: reported %d added but the table grew by %d (%d -> %d). "
             "Some rows were rejected for a reason other than a duplicate fingerprint -- "
             "check the schema before trusting this database."
             % (added, final_rows - existing_rows, existing_rows, final_rows))

    verb = "would add" if dry else "added"
    out("      records in file  : %d" % total)
    out("      %-16s : %d" % (verb, added))
    out("      duplicates       : %d skipped silently (%d already in db, %d repeated in file)"
        % (dup_db + dup_file, dup_db, dup_file))
    out("      records with img : %d" % with_images)
    out("      unique images    : %d (%d %s, %s)"
        % (len(store.seen), len(store.written),
           "would be written" if dry else "written to disk", human(store.bytes_written)))
    if store.reused:
        out("      images reused    : %d already on disk" % len(store.reused))
    if store.bytes_total != store.bytes_written:
        out("      image bytes seen : %s decoded in total (identical images collapse to one file)"
            % human(store.bytes_total))
    out("      meta keys        : %d %s%s"
        % (len(written_meta), "would be written" if dry else "written",
           (" -- " + ", ".join(written_meta)) if written_meta else ""))
    if st.fp_computed:
        out("      fingerprints computed (missing in file): %d" % st.fp_computed)
    if st.month_key_filled:
        out("      monthKey filled from dateStr : %d" % st.month_key_filled)
    if st.month_label_filled:
        out("      monthLabel filled from dateStr: %d" % st.month_label_filled)
    if st.type_normalised:
        out("      unknown type -> expense      : %d" % st.type_normalised)
    if st.date_dropped:
        warn("%d record(s) had an unparseable `date`; stored as NULL. dateStr was kept verbatim."
             % st.date_dropped)
    if st.image_bad:
        warn("%d record(s) had an image field that was neither a data URL nor a 64-hex hash; "
             "stored as NULL." % st.image_bad)
    if st.image_hash_kept:
        out("      images already hashed        : %d" % st.image_hash_kept)
    if not dry:
        out("      database now holds %d record(s), %d image(s)" % (final_rows, final_imgs))
        out("      db file: %s" % human(db_path.stat().st_size))
    out("\n%s  (%.1fs)" % ("Dry run complete -- nothing was written." if dry else "Done.",
                            time.time() - t0))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\ninterrupted", file=sys.stderr)
        raise SystemExit(130)
