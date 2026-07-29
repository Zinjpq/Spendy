#!/usr/bin/env python3
"""
Spendy server — the whole backend, one file, standard library only.

WHY THIS FILE LOOKS LIKE THIS
-----------------------------
The app used to keep everything in the browser (IndexedDB + a 64 MB `spendy-db.js`
snapshot shuttled through Google Drive). That worked for one machine and quietly lost
edits on the second one. So SQLite on a box the user owns becomes the single source of
truth and the browser keeps nothing. Everything below exists to make that swap safe.

The rules that shaped the code, in the order they will bite you if you forget them:

* **Dates are local calendar days, and the client already computed them.** `dateStr`,
  `monthKey` and `monthLabel` are stored VERBATIM. The server never derives a day from a
  timestamp — in UTC+7 a `toISOString().slice(0,10)` moves every Vietnamese transaction
  back one day, which is exactly the bug this project already paid for once. `date` is
  carried along as an opaque instant and is never read back to rebuild a day.

* **`fingerprint` is the dedup design, not a nicety.** `name|amount|category|dateStr`,
  computed by the client, UNIQUE in SQL. Re-importing the same CSV, restoring the same
  backup twice, merging the legacy installment rows — all of it is idempotent only
  because a colliding insert is SKIPPED SILENTLY. A duplicate is never an error and never
  aborts a batch; anything else that fails rolls the whole batch back.

* **Payloads are big.** The real dataset is ~61 MB, almost all of it base64 attachment
  images. Nothing here reads a body twice: `read_body()` grows a single buffer as bytes
  ARRIVE (never sized from the Content-Length header, which is a promise an attacker can
  make and not keep), restore uploads stream straight to a temp file, backup.zip is
  assembled on disk, and image responses are `copyfileobj`'d instead of `.read()`.
  Everything that must live in RAM has a ceiling, and the ceilings are shared: MAX_BODY
  for a streamed upload, MAX_JSON_BODY for anything parsed as JSON, MAX_BACKUP_JSON for a
  zip member (a 1.2 MB deflate bomb otherwise inflates to gigabytes), MAX_INFLIGHT across
  all threads, STAGE_BUDGET for the staging directory.

* **Vietnamese text goes through every layer.** JSON is dumped with `ensure_ascii=False`
  and encoded UTF-8 by hand, SQLite is UTF-8 by nature, zip entry names are ASCII hashes.
  Nothing may "helpfully" escape đ/ế/ộ into `\\uXXXX` on the way out.

* **Writes serialize, reads do not.** `ThreadingHTTPServer` + one sqlite3 connection per
  request (connections are not thread-safe to share) + ONE process-wide lock held across
  every write transaction. WAL lets readers keep working while a 61 MB import commits.

* **Nothing personal is written inside the repo.** `$SPENDY_DATA` holds the db, the image
  blobs and the restore staging area; `$SPENDY_APP_DIR` is read-only static hosting.

Images are content-addressed (sha256 of the RAW bytes) so the same receipt attached twice
costs one file, and so `GET /api/images/<hash>` can be cached forever. Deleting a record
never deletes bytes — `POST /api/maintenance/gc-images` sweeps orphans when the user asks.

No auth by design: LAN/VPN only, bind address configurable so it stays off the internet.
"""

import base64
import contextlib
import hashlib
import json
import os
import re
import secrets
import shutil
import signal
import sqlite3
import sys
import threading
import time
import traceback
import urllib.parse
import zipfile
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

APP_VERSION = '1.0.0'

# ---------------------------------------------------------------------------
# Configuration (environment)
# ---------------------------------------------------------------------------


def _env(name, default):
    """Env var, treating an empty string as unset (Docker passes those around)."""
    value = os.environ.get(name)
    return value if value not in (None, '') else default


def _default_app_dir():
    """Where Spendy.html lives. In the repo that's the parent of server/; in the image
    it is whatever SPENDY_APP_DIR says. Guessing keeps `python server/app.py` usable."""
    here = os.path.dirname(os.path.abspath(__file__))
    for candidate in (os.path.dirname(here), here, os.getcwd()):
        if os.path.isfile(os.path.join(candidate, 'Spendy.html')):
            return candidate
    return os.path.dirname(here)


DATA_DIR = os.path.abspath(_env('SPENDY_DATA', '/data'))
APP_DIR = os.path.abspath(_env('SPENDY_APP_DIR', _default_app_dir()))
HOST = _env('SPENDY_HOST', '0.0.0.0')
try:
    PORT = int(_env('SPENDY_PORT', '8765'))
except ValueError:
    PORT = 8765

APP_ROOT = os.path.realpath(APP_DIR)  # every static path must resolve inside this

DB_PATH = os.path.join(DATA_DIR, 'spendy.db')
IMG_DIR = os.path.join(DATA_DIR, 'images')
TMP_DIR = os.path.join(DATA_DIR, 'tmp')

MAX_BODY = 512 * 1024 * 1024      # hard ceiling on any request body (restore uploads only)
MAX_JSON_BODY = 128 * 1024 * 1024  # ceiling on a body that must exist in RAM as JSON
MAX_BACKUP_JSON = 128 * 1024 * 1024  # decompressed size of a backup .json (zip member or bare file)
MAX_IMAGE = 25 * 1024 * 1024      # one decoded attachment; phone photos are ~5 MB
STAGE_TTL = 1800                  # staged restore uploads are swept after 30 minutes
STAGE_BUDGET = 2 * 1024 * 1024 * 1024   # total bytes allowed to sit in $SPENDY_DATA/tmp
MAX_INFLIGHT = 256 * 1024 * 1024  # request bodies being accumulated in RAM, all threads
CHUNK = 256 * 1024                # streaming granularity everywhere
IDLE_TIMEOUT = 120                # reap keep-alive sockets so threads do not pile up

# One process-wide write lock. Held for the whole of every write transaction, so two
# requests can never interleave BEGIN IMMEDIATE / COMMIT on separate connections.
WRITE_LOCK = threading.Lock()
LOG_LOCK = threading.Lock()

# Bytes of request body currently being accumulated in memory, across all threads. A
# request reserves what it has ACTUALLY received (never what Content-Length claims), so
# parallel uploads cannot multiply the per-request ceiling into an OOM.
INFLIGHT_LOCK = threading.Lock()
_inflight_bytes = 0

# token of the newest staged restore upload per client address, so picking a second file
# in the restore dialog does not leave the first one occupying disk for STAGE_TTL.
STAGED_LOCK = threading.Lock()
STAGED_BY_CLIENT = {}

# Set by init_db(). False only on a database that already held duplicate fingerprints, so
# the UNIQUE index could not be created — see insert_record().
FP_INDEX_OK = True


def inflight_take(n):
    """Reserve n bytes of the in-memory body budget, or refuse the request."""
    global _inflight_bytes
    with INFLIGHT_LOCK:
        if _inflight_bytes + n > MAX_INFLIGHT:
            raise ApiError(503, 'server_busy',
                           'too many large uploads in flight; retry in a moment')
        _inflight_bytes += n
    return n


def inflight_release(n):
    global _inflight_bytes
    if not n:
        return
    with INFLIGHT_LOCK:
        _inflight_bytes = max(0, _inflight_bytes - n)

RE_HASH = re.compile(r'^[0-9a-f]{64}$')
RE_TOKEN = re.compile(r'^[0-9a-f]{32}$')
RE_ZIP_IMAGE = re.compile(r'^images/[0-9a-f]{64}\.[a-z0-9]{1,5}$')

RECORD_TYPES = ('expense', 'income', 'invest', 'debt')

EXT_BY_MIME = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif',
    'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/avif': 'avif',
    'image/heic': 'heic', 'image/heif': 'heif', 'image/tiff': 'tiff', 'image/x-icon': 'ico',
    'image/vnd.microsoft.icon': 'ico',
}
MIME_BY_EXT = {
    'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'gif': 'image/gif',
    'webp': 'image/webp', 'svg': 'image/svg+xml', 'bmp': 'image/bmp', 'avif': 'image/avif',
    'heic': 'image/heic', 'heif': 'image/heif', 'tiff': 'image/tiff', 'ico': 'image/x-icon',
    'bin': 'application/octet-stream',
}

# Static hosting whitelist, straight from the contract.
STATIC_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
}
# Spendy.html / spendy.js must never be cached or a redeploy is invisible on reload.
STATIC_NO_CACHE = {'.html', '.js', '.css', '.json', '.map'}
# ALLOW-list, not a deny-list. The app is exactly three things plus vendored libraries, and
# SPENDY_APP_DIR is very often the user's own working folder — which also holds spendy-db.js,
# spendy-sync.json and any spendy-backup-*.json they have downloaded. An extension whitelist
# with a few denied names would still hand those to anyone on the LAN (no auth, remember),
# and every new data file anyone drops beside the app would silently become public. Naming
# what IS served is the only version of this rule that stays correct as the folder changes.
STATIC_FILES = {'spendy.html', 'spendy.js', 'favicon.ico'}
STATIC_DIRS = ('vendor',)   # first path segment allowed to hold servable files

# CORS. docs/API.md v1 asked for a blanket `Access-Control-Allow-Origin: *` on every
# response, for the convenience of opening the page from another origin while developing.
# That is not survivable here: there is NO AUTH, so with `*` any web page the owner happens
# to visit can read GET /api/state — which carries card numbers, expiry and CVV in the
# clear — and can call DELETE /api/records, once it guesses the LAN address. Verified end
# to end from a hostile origin before this was narrowed.
#
# So: `*` is still sent when the request carries no Origin at all (curl, the healthcheck,
# same-origin navigations — nothing a browser will act on). A browser Origin is echoed back
# ONLY when it is the origin this server was reached on, or a loopback dev server, or one
# the operator listed explicitly. Anything else gets no CORS header at all, and is refused
# outright on POST/PUT/DELETE so a form-style cross-site write cannot land either.
# `null` (file:// pages, but also any sandboxed iframe an attacker can create) is NOT
# trusted by default: set SPENDY_CORS_ANY=1 if you really are developing from file://.
CORS_METHODS = 'GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD'
CORS_ALLOW_HEADERS = 'Content-Type, Accept'
CORS_MAX_AGE = '86400'
CORS_ANY = (_env('SPENDY_CORS_ANY', '') or '').strip().lower() in ('1', 'true', 'yes', 'on')
CORS_ORIGINS = tuple(o.strip().rstrip('/').lower()
                     for o in (_env('SPENDY_CORS_ORIGINS', '') or '').split(',') if o.strip())
CORS_LOCAL_HOSTS = ('localhost', '127.0.0.1', '::1')
MUTATING_METHODS = ('POST', 'PUT', 'DELETE', 'PATCH')

# Status code → machine-readable slug, for the responses BaseHTTPRequestHandler produces on
# its own (unknown verb, malformed request line, over-long URL). The contract says non-2xx
# is ALWAYS the JSON error shape; those paths used to emit an HTML page with no CORS header.
ERROR_SLUGS = {
    400: 'bad_request', 404: 'not_found', 405: 'method_not_allowed', 408: 'timeout',
    411: 'length_required', 413: 'body_too_large', 414: 'uri_too_long',
    431: 'headers_too_large', 500: 'internal', 501: 'not_implemented',
    505: 'http_version_not_supported',
}

# Canonical backup shape. Meta rows present in the DB overwrite these, but the keys are
# always emitted so an old client restoring a fresh backup finds what it expects.
BACKUP_DEFAULTS = {
    'budgets': {}, 'goal': 0, 'catClass': {}, 'incomeBase': 0, 'cats': {}, 'plans': [],
    'debts': [], 'ccPaidFps': [], 'ccPaidAt': {}, 'ccNoteFps': {}, 'catOk': [],
    'cards': [], 'pinnedCard': None,
}
# Reserved top-level keys in a backup file — everything else in the file is a meta key.
BACKUP_RESERVED = ('app', 'version', 'savedAt', 'records')


class ApiError(Exception):
    """Anything the client did wrong. Carries the status and the error contract fields."""

    def __init__(self, status, error, detail='', extra=None):
        super().__init__(detail or error)
        self.status = status
        self.error = error
        self.detail = detail
        self.extra = extra or {}


def now_ms():
    return int(time.time() * 1000)


# ---------------------------------------------------------------------------
# SQLite: schema init / migration
# ---------------------------------------------------------------------------

# Kept as separate statements on purpose: executescript() would COMMIT the transaction
# write_tx() just opened, and the COMMIT afterwards would then fail on a dead transaction.
SCHEMA_STATEMENTS = (
    """CREATE TABLE IF NOT EXISTS records (
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
)""",
    """CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
)""",
    """CREATE TABLE IF NOT EXISTS images (
  hash    TEXT PRIMARY KEY,
  mime    TEXT NOT NULL,
  ext     TEXT NOT NULL,
  bytes   INTEGER NOT NULL,
  created INTEGER NOT NULL
)""",
)

# Columns a records table must have. Used to patch a table created by an older
# server/migrate.py — ALTER TABLE ADD COLUMN is the only widening SQLite allows.
RECORD_COLUMNS = (
    ('name', "TEXT NOT NULL DEFAULT ''"),
    ('amount', 'REAL NOT NULL DEFAULT 0'),
    ('type', "TEXT NOT NULL DEFAULT 'expense'"),
    ('category', "TEXT NOT NULL DEFAULT ''"),
    ('method', "TEXT NOT NULL DEFAULT ''"),
    ('date', 'INTEGER'),
    ('dateStr', "TEXT NOT NULL DEFAULT ''"),
    ('monthKey', "TEXT NOT NULL DEFAULT 'Unknown'"),
    ('monthLabel', "TEXT NOT NULL DEFAULT 'Unknown'"),
    ('fingerprint', "TEXT NOT NULL DEFAULT ''"),
    ('image', 'TEXT'),
    ('installments', 'INTEGER'),
)


def connect():
    """One connection per request. sqlite3 connections are not safe to share between
    threads, and pooling them buys nothing for a single-user LAN server."""
    conn = sqlite3.connect(DB_PATH, timeout=10.0, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')     # readers keep working during a big import
    conn.execute('PRAGMA foreign_keys=ON')
    conn.execute('PRAGMA busy_timeout=5000')
    conn.execute('PRAGMA synchronous=NORMAL')   # safe under WAL, and much faster on import
    return conn


@contextlib.contextmanager
def write_tx(conn):
    """Every write goes through here: process-wide lock + BEGIN IMMEDIATE + all-or-nothing.
    Reads never take the lock."""
    with WRITE_LOCK:
        conn.execute('BEGIN IMMEDIATE')
        try:
            yield conn
        except BaseException:
            with contextlib.suppress(Exception):
                conn.execute('ROLLBACK')
            raise
        conn.execute('COMMIT')


def _quote_ident(name):
    return '"' + str(name).replace('"', '""') + '"'


def _has_fingerprint_unique(conn):
    for idx in conn.execute('PRAGMA index_list(records)').fetchall():
        if not idx['unique']:
            continue
        cols = [c['name'] for c in
                conn.execute('PRAGMA index_info(%s)' % _quote_ident(idx['name'])).fetchall()]
        if cols == ['fingerprint']:
            return True
    return False


def init_db():
    """Idempotent. Also has to accept a database created by server/migrate.py, which may
    have built the table itself — so widen missing columns instead of assuming ours."""
    global FP_INDEX_OK
    for path in (DATA_DIR, IMG_DIR, TMP_DIR):
        os.makedirs(path, exist_ok=True)
    conn = connect()
    try:
        with write_tx(conn):
            for statement in SCHEMA_STATEMENTS:
                conn.execute(statement)
            existing = {row['name'] for row in
                        conn.execute('PRAGMA table_info(records)').fetchall()}
            for col, ddl in RECORD_COLUMNS:
                if col not in existing:
                    conn.execute('ALTER TABLE records ADD COLUMN %s %s' % (_quote_ident(col), ddl))
            have = {row['name'] for row in
                    conn.execute('PRAGMA table_info(images)').fetchall()}
            for col, ddl in (('mime', "TEXT NOT NULL DEFAULT 'application/octet-stream'"),
                             ('ext', "TEXT NOT NULL DEFAULT 'bin'"),
                             ('bytes', 'INTEGER NOT NULL DEFAULT 0'),
                             ('created', 'INTEGER NOT NULL DEFAULT 0')):
                if col not in have:
                    conn.execute('ALTER TABLE images ADD COLUMN %s %s' % (_quote_ident(col), ddl))
        if not _has_fingerprint_unique(conn):
            # Not inside the schema script: on a database that already holds duplicate
            # fingerprints this fails, and that is worth a loud warning rather than a crash.
            try:
                with write_tx(conn):
                    conn.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_records_fp '
                                 'ON records(fingerprint)')
            except sqlite3.DatabaseError as exc:
                log_line('WARN  could not create unique index on records.fingerprint: %s '
                         '(dedup is degraded until the duplicates are removed)' % exc)
        # Degraded mode has to be REAL, not just a friendly log line: without that index
        # `ON CONFLICT(fingerprint) DO NOTHING` is an OperationalError, so every insert
        # would 500 while /api/health still reported the server healthy. insert_record()
        # switches to an explicit lookup when this is False.
        FP_INDEX_OK = _has_fingerprint_unique(conn)
        if not FP_INDEX_OK:
            log_line('WARN  records.fingerprint has NO unique index — falling back to an '
                     'explicit duplicate check on every insert. Remove the duplicate '
                     'fingerprints and restart to restore the real guarantee.')
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Helpers: JSON, records, meta, images
# ---------------------------------------------------------------------------


def dumps(payload):
    """UTF-8 bytes, no ensure_ascii. Vietnamese must survive as Vietnamese.

    `allow_nan=False` is the important part: Python's default writes the bare tokens
    `Infinity` / `NaN`, which are not JSON and which `JSON.parse` refuses. One such value
    in the database would make /api/state unparseable — the app would never finish
    booting, and the backup written to escape the mess would be invalid too. Better to
    fail loudly here (a 500 with a readable detail) than to emit something no browser can
    read. record_from_json() rejects non-finite amounts on the way IN; this is the wall on
    the way OUT for anything that got in another way."""
    return json.dumps(payload, ensure_ascii=False, allow_nan=False,
                      separators=(',', ':')).encode('utf-8')


def log_line(text):
    """One line, stdout, flushed — `docker logs` is the only observability here.
    A logging failure must never take a request down with it."""
    with LOG_LOCK:
        try:
            sys.stdout.write('%s %s\n' % (time.strftime('%Y-%m-%d %H:%M:%S'), text))
            sys.stdout.flush()
        except UnicodeEncodeError:
            sys.stdout.write(text.encode('ascii', 'replace').decode('ascii') + '\n')
            sys.stdout.flush()
        except Exception:
            pass


def _js_number(value):
    """JS `${n}` semantics, needed only by the fingerprint fallback below."""
    number = float(value)
    if number != number or number in (float('inf'), float('-inf')):
        return 'NaN' if number != number else ('Infinity' if number > 0 else '-Infinity')
    if number.is_integer() and abs(number) < 1e21:
        return str(int(number))
    return repr(number)


def coerce_date(value):
    """`date` is an opaque instant (epoch ms). NEVER used to rebuild dateStr/monthKey —
    that is the UTC-rollback bug. An ISO string is converted instant→instant, which is
    lossless and does not touch any calendar field."""
    if value is None or value is True or value is False or value == '':
        return None
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str):
        text = value.strip()
        if re.fullmatch(r'-?\d+', text):
            return int(text)
        try:
            parsed = datetime.fromisoformat(text.replace('Z', '+00:00'))
        except ValueError:
            return None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return int(parsed.timestamp() * 1000)
    return None


def _decode_base64(payload):
    """Tolerate embedded whitespace and missing padding; both show up in hand-edited
    backups and in data URLs that went through a line-wrapping editor."""
    try:
        return base64.b64decode(payload)
    except Exception:
        pass
    cleaned = ''.join(payload.split())
    cleaned += '=' * (-len(cleaned) % 4)
    try:
        return base64.b64decode(cleaned)
    except Exception:
        return None


def image_file_path(hash_hex, ext):
    return os.path.join(IMG_DIR, hash_hex[:2], '%s.%s' % (hash_hex, ext))


def store_image_bytes(conn, raw, mime):
    """Content-addressed write: sha256 of the RAW bytes names the file, so the same
    attachment stored twice costs one file. Caller must hold the write lock."""
    if len(raw) > MAX_IMAGE:
        raise ApiError(413, 'image_too_large',
                       'image is %d bytes, limit is %d' % (len(raw), MAX_IMAGE))
    hash_hex = hashlib.sha256(raw).hexdigest()
    ext = EXT_BY_MIME.get((mime or '').lower(), 'bin')
    row = conn.execute('SELECT ext FROM images WHERE hash=?', (hash_hex,)).fetchone()
    if row and row['ext']:
        ext = row['ext']  # a second copy declaring another mime must not orphan the first file
    dest = image_file_path(hash_hex, ext)
    if not os.path.exists(dest):
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        tmp = '%s.%s.part' % (dest, secrets.token_hex(4))
        with open(tmp, 'wb') as handle:
            handle.write(raw)
        os.replace(tmp, dest)  # atomic: a reader never sees a half-written attachment
    conn.execute('INSERT INTO images(hash,mime,ext,bytes,created) VALUES(?,?,?,?,?) '
                 'ON CONFLICT(hash) DO NOTHING',
                 (hash_hex, mime or MIME_BY_EXT.get(ext, 'application/octet-stream'),
                  ext, len(raw), now_ms()))
    return hash_hex


def normalize_image(value, conn):
    """The single rule every write path shares: data-URL in → bytes stored, hash out.
    A 64-hex hash passes through untouched. Anything else becomes NULL, so the edit
    modal, CSV import, restore of an ancient backup and migrate.py all behave the same."""
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    if RE_HASH.match(text):
        return text
    if not text[:5].lower() == 'data:':
        return None
    head, sep, payload = text.partition(',')
    if not sep:
        return None
    meta = head[5:]
    if ';base64' not in meta.lower():
        return None  # percent-encoded data URLs are not images we produce
    mime = meta.split(';')[0].strip().lower() or 'application/octet-stream'
    # Cheap guard before spending memory on the decode: base64 is 4 chars per 3 bytes.
    if (len(payload) // 4) * 3 > MAX_IMAGE:
        raise ApiError(413, 'image_too_large', 'attached image exceeds %d bytes' % MAX_IMAGE)
    raw = _decode_base64(payload)
    if not raw:
        return None
    return store_image_bytes(conn, raw, mime)


def row_to_record(row):
    """Wire shape. Integral floats are emitted as ints so a round-trip through the client
    reproduces byte-identical fingerprints."""
    amount = row['amount']
    if isinstance(amount, float) and amount.is_integer():
        amount = int(amount)
    return {
        'id': row['id'],
        'name': row['name'],
        'amount': amount,
        'type': row['type'],
        'category': row['category'],
        'method': row['method'],
        'date': row['date'],
        'dateStr': row['dateStr'],
        'monthKey': row['monthKey'],
        'monthLabel': row['monthLabel'],
        'fingerprint': row['fingerprint'],
        'image': row['image'],
        'installments': row['installments'],
    }


def record_from_json(obj, conn, allow_fp_fallback=False):
    """JSON → column tuple. Calendar fields are copied verbatim; the server does not
    recompute a single one of them."""
    if not isinstance(obj, dict):
        raise ApiError(400, 'bad_record', 'record must be a JSON object')
    name = obj.get('name')
    name = '' if name is None else str(name)
    try:
        amount = float(obj.get('amount') or 0)
    except OverflowError:
        # a 400-digit integer amount: float() cannot represent it at all
        raise ApiError(400, 'bad_amount', 'amount is out of range')
    except (TypeError, ValueError):
        amount = 0.0   # unparseable garbage has always been treated as 0
    # inf / -inf / nan must never reach the table. SQLite stores them happily, and then
    # json.dumps writes the bare token `Infinity` into /api/state and into every backup —
    # neither is JSON, so the app can no longer boot and the escape-hatch backup is
    # invalid too. (`"amount": 1e999` in a hand-edited backup is all it takes.)
    if amount != amount or amount in (float('inf'), float('-inf')):
        raise ApiError(400, 'bad_amount',
                       'amount must be a finite number (record %r)' % (name[:60] or '?'))
    rtype = obj.get('type')
    rtype = rtype if rtype in RECORD_TYPES else 'expense'
    category = obj.get('category')
    category = '' if category is None else str(category)
    method = obj.get('method')
    method = '' if method is None else str(method)
    date_ms = coerce_date(obj.get('date'))
    date_str = obj.get('dateStr')
    date_str = '' if date_str is None else str(date_str)
    month_key = obj.get('monthKey') or 'Unknown'
    month_label = obj.get('monthLabel') or 'Unknown'

    fingerprint = obj.get('fingerprint')
    fingerprint = '' if fingerprint is None else str(fingerprint)
    if not fingerprint:
        if not allow_fp_fallback:
            raise ApiError(400, 'missing_fingerprint',
                           'the client computes fingerprint (name|amount|category|dateStr); '
                           'the server never recomputes it')
        # Restore only: a hand-made or truncated file. Rebuild the client formula so the
        # file is importable at all, rather than rejecting the user's whole backup.
        fingerprint = '%s|%s|%s|%s' % (name, _js_number(amount), category, date_str)

    image = normalize_image(obj.get('image'), conn)

    installments = obj.get('installments')
    try:
        installments = int(installments)
    except (TypeError, ValueError):
        installments = None
    if installments is None or installments < 2:
        installments = None

    return (name, amount, rtype, category, method, date_ms, date_str,
            str(month_key), str(month_label), fingerprint, image, installments)


def _identity_key(obj):
    """(name, amount, dateStr) with exactly the coercion record_from_json applies.

    Three quarters of a fingerprint: two records with the same fingerprint necessarily
    agree on these, whatever their category. records_replace_all() uses that to tell a row
    the client deliberately merged away from a row it has never seen."""
    name = obj.get('name')
    name = '' if name is None else str(name)
    try:
        amount = float(obj.get('amount') or 0)
    except (TypeError, ValueError, OverflowError):
        amount = 0.0
    date_str = obj.get('dateStr')
    date_str = '' if date_str is None else str(date_str)
    return (name, amount, date_str)


RECORD_FIELDS = ('name', 'amount', 'type', 'category', 'method', 'date', 'dateStr',
                 'monthKey', 'monthLabel', 'fingerprint', 'image', 'installments')

INSERT_SQL = ('INSERT INTO records(name,amount,type,category,method,date,dateStr,'
              'monthKey,monthLabel,fingerprint,image,installments) '
              'VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(fingerprint) DO NOTHING')

# Same insert without the conflict clause. SQLite REJECTS `ON CONFLICT(fingerprint)` when
# no unique constraint on that column exists (OperationalError, not IntegrityError), so on
# a degraded database the statement above cannot be used at all.
PLAIN_INSERT_SQL = ('INSERT INTO records(name,amount,type,category,method,date,dateStr,'
                    'monthKey,monthLabel,fingerprint,image,installments) '
                    'VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')

UPDATE_SQL = ('UPDATE records SET name=?,amount=?,type=?,category=?,method=?,date=?,'
              'dateStr=?,monthKey=?,monthLabel=?,fingerprint=?,image=?,installments=? '
              'WHERE id=?')

# replaceAll writes the id explicitly so a rename keeps every row's identity. A NULL id
# still autoincrements, so a caller may mix new rows in. NO "on conflict do nothing" here:
# during a replaceAll a duplicate fingerprint means the caller's dedup was wrong, and
# silently dropping one of the user's transactions is far worse than failing the request.
REPLACE_INSERT_SQL = ('INSERT INTO records(id,name,amount,type,category,method,date,dateStr,'
                      'monthKey,monthLabel,fingerprint,image,installments) '
                      'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')


def values_to_record(values, row_id):
    record = dict(zip(RECORD_FIELDS, values))
    amount = record['amount']
    if isinstance(amount, float) and amount.is_integer():
        record['amount'] = int(amount)
    record['id'] = row_id
    return record


def insert_record(conn, values):
    """Returns the new id, or None when the fingerprint already exists. A duplicate is
    SKIPPED — never an error, never an abort. This mirrors the old
    swallow-ConstraintError behaviour the whole import/restore/sync design leans on."""
    if not FP_INDEX_OK:
        # Degraded database: no unique index, so ON CONFLICT would raise OperationalError
        # and every write would 500 behind a "healthy" healthcheck. Look the fingerprint up
        # instead — race-free anyway, because every write path holds WRITE_LOCK and runs
        # inside BEGIN IMMEDIATE, and the semantics (silent skip) are identical.
        if conn.execute('SELECT 1 FROM records WHERE fingerprint=? LIMIT 1',
                        (values[9],)).fetchone():
            return None
        return conn.execute(PLAIN_INSERT_SQL, values).lastrowid
    try:
        cur = conn.execute(INSERT_SQL, values)
    except sqlite3.IntegrityError as exc:
        # Belt and braces for a SQLite too old for ON CONFLICT DO NOTHING.
        if 'fingerprint' in str(exc):
            return None
        raise
    return cur.lastrowid if cur.rowcount else None


def read_meta(conn):
    """meta values are JSON text; hand them back decoded. A value that somehow is not
    JSON is passed through as a string rather than losing the user's data."""
    out = {}
    for row in conn.execute('SELECT key, value FROM meta').fetchall():
        try:
            out[row['key']] = json.loads(row['value'])
        except (ValueError, TypeError):
            out[row['key']] = row['value']
    return out


def write_meta(conn, key, value):
    """None deletes. Returns True when something was applied."""
    if not isinstance(key, str) or not key or len(key) > 200 or any(c < ' ' for c in key):
        raise ApiError(400, 'bad_meta_key', 'meta key must be a short printable string')
    if value is None:
        conn.execute('DELETE FROM meta WHERE key=?', (key,))
        return True
    conn.execute('INSERT INTO meta(key,value) VALUES(?,?) '
                 'ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                 (key, json.dumps(value, ensure_ascii=False)))
    return True


def build_backup_payload(conn):
    """Identical shape to the app's old JSON backup, plus every meta key present — the
    user asked explicitly that card details round-trip through a backup."""
    payload = {'app': 'spendy', 'version': 1, 'savedAt': now_ms()}
    payload.update(BACKUP_DEFAULTS)
    payload.update(read_meta(conn))
    records = []
    for row in conn.execute('SELECT * FROM records ORDER BY id').fetchall():
        record = row_to_record(row)
        record.pop('id', None)  # ids are SQLite's, fingerprints are the identity
        records.append(record)
    payload['records'] = records
    return payload


def resolve_image(conn, hash_hex):
    """(path, mime, ext) for a stored hash, or None. Falls back to a directory probe so a
    file that arrived without its images row (hand-copied, half-finished migration) still
    serves."""
    row = conn.execute('SELECT mime, ext FROM images WHERE hash=?', (hash_hex,)).fetchone()
    if row:
        path = image_file_path(hash_hex, row['ext'])
        if os.path.isfile(path):
            return path, row['mime'], row['ext']
    shard = os.path.join(IMG_DIR, hash_hex[:2])
    try:
        entries = os.listdir(shard)
    except OSError:
        return None
    for name in entries:
        if name.startswith(hash_hex + '.') and not name.endswith('.part'):
            ext = name.rsplit('.', 1)[-1].lower()
            return (os.path.join(shard, name),
                    MIME_BY_EXT.get(ext, 'application/octet-stream'), ext)
    return None


def sweep_tmp():
    """Staged restore uploads older than STAGE_TTL are abandoned confirmations.

    Called on stage AND on commit: sweeping only at the start of the next stage meant a
    user who staged three files and walked away kept all three on disk until they happened
    to open the restore dialog again."""
    cutoff = time.time() - STAGE_TTL
    try:
        entries = os.listdir(TMP_DIR)
    except OSError:
        return
    for name in entries:
        path = os.path.join(TMP_DIR, name)
        try:
            if os.path.isfile(path) and os.path.getmtime(path) < cutoff:
                os.remove(path)
        except OSError:
            pass


def tmp_usage():
    """Bytes currently parked in the staging area."""
    total = 0
    try:
        entries = os.listdir(TMP_DIR)
    except OSError:
        return 0
    for name in entries:
        with contextlib.suppress(OSError):
            total += os.path.getsize(os.path.join(TMP_DIR, name))
    return total


def drop_previous_staged(client):
    """One live staged upload per caller. Picking a second file in the restore dialog (or
    cancelling and picking another) must not leave the first one holding disk."""
    if not client:
        return
    with STAGED_LOCK:
        previous = STAGED_BY_CLIENT.pop(client, None)
    if previous and RE_TOKEN.match(previous):
        with contextlib.suppress(OSError):
            os.remove(os.path.join(TMP_DIR, previous))


def remember_staged(client, token):
    if not client:
        return
    with STAGED_LOCK:
        if len(STAGED_BY_CLIENT) > 256:      # a LAN cannot have this many callers
            STAGED_BY_CLIENT.clear()
        STAGED_BY_CLIENT[client] = token


def forget_staged(token):
    with STAGED_LOCK:
        for client, value in list(STAGED_BY_CLIENT.items()):
            if value == token:
                del STAGED_BY_CLIENT[client]


# ---------------------------------------------------------------------------
# Restore staging helpers (zip / json)
# ---------------------------------------------------------------------------


def _zip_entry_kind(info):
    """'json', 'image', 'skip' or None(=reject). No zip-slip, no symlinks, no surprises."""
    name = info.filename
    if not name or name.startswith('/') or name.startswith('\\') or ':' in name[:3]:
        return None
    if '\\' in name:
        return None
    parts = name.split('/')
    if any(part in ('..', '.') for part in parts):
        return None
    if name.endswith('/'):
        # A bare directory entry carries no bytes; tolerate images/ so zips produced by
        # generic tools still restore, reject any other directory.
        return 'skip' if name in ('images/',) else None
    mode = (info.external_attr >> 16) & 0o170000
    if mode and mode != 0o100000:      # anything that is not a regular file (symlink, fifo…)
        return None
    if RE_ZIP_IMAGE.match(name):
        return 'image'
    if '/' not in name and name.lower().endswith('.json'):
        return 'json'
    return None


def open_staged(path):
    """(payload, zip_handle_or_None). Content sniffed, Content-Type ignored per contract."""
    with open(path, 'rb') as handle:
        signature = handle.read(4)
    if signature == b'PK\x03\x04':
        try:
            archive = zipfile.ZipFile(path)
        except zipfile.BadZipFile as exc:
            raise ApiError(400, 'bad_zip', 'not a readable zip: %s' % exc)
        json_names = []
        for info in archive.infolist():
            kind = _zip_entry_kind(info)
            if kind is None:
                archive.close()
                raise ApiError(400, 'bad_zip_entry',
                               'refusing archive entry %r — only images/<64-hex>.<ext> and a '
                               'single backup .json are allowed' % info.filename)
            if kind == 'json':
                json_names.append(info.filename)
        if not json_names:
            archive.close()
            raise ApiError(400, 'no_backup_json', 'archive contains no backup .json')
        name = ('spendy-backup.json' if 'spendy-backup.json' in json_names
                else (json_names[0] if len(json_names) == 1 else None))
        if name is None:
            archive.close()
            raise ApiError(400, 'ambiguous_backup_json',
                           'archive holds %d json files; expected spendy-backup.json'
                           % len(json_names))
        # DEFLATE bomb guard. Image members are size-checked in _zip_entry_kind and again
        # while streaming; the json member used to be read with archive.read(), i.e. with
        # no limit at all — a 1.22 MB upload whose single member inflates to 1.2 GB grew
        # RSS by 2.2 GB and could be sent from an ordinary web page. Both the declared size
        # and the running total are checked, since the header is attacker-controlled.
        info = archive.getinfo(name)
        if info.file_size > MAX_BACKUP_JSON:
            archive.close()
            raise ApiError(413, 'backup_json_too_large',
                           'backup json declares %d bytes; the limit is %d'
                           % (info.file_size, MAX_BACKUP_JSON))
        raw = bytearray()
        try:
            with archive.open(info) as src:
                while True:
                    chunk = src.read(CHUNK)
                    if not chunk:
                        break
                    raw += chunk
                    if len(raw) > MAX_BACKUP_JSON:
                        raise ApiError(413, 'backup_json_too_large',
                                       'backup json exceeds %d bytes' % MAX_BACKUP_JSON)
        except BaseException:
            archive.close()
            raise
        try:
            payload = json.loads(raw)
        except ValueError as exc:
            archive.close()
            raise ApiError(400, 'bad_json', 'backup json is not valid JSON: %s' % exc)
        del raw
        return payload, archive
    if os.path.getsize(path) > MAX_BACKUP_JSON:
        raise ApiError(413, 'backup_json_too_large',
                       'a bare backup .json may not exceed %d bytes (zip it instead)'
                       % MAX_BACKUP_JSON)
    try:
        with open(path, 'rb') as handle:
            payload = json.load(handle)
    except ValueError as exc:
        raise ApiError(400, 'bad_json', 'uploaded file is neither a zip nor valid JSON: %s' % exc)
    return payload, None


def staged_records(payload):
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict) and isinstance(payload.get('records'), list):
        return payload['records']
    raise ApiError(400, 'not_a_backup', 'file has no "records" array')


def staged_meta_keys(payload):
    if not isinstance(payload, dict):
        return []
    return [k for k in payload.keys() if k not in BACKUP_RESERVED]


def record_fingerprint_for_preview(obj):
    if not isinstance(obj, dict):
        return None
    fingerprint = obj.get('fingerprint')
    if fingerprint:
        return str(fingerprint)
    try:
        amount = float(obj.get('amount') or 0)
    except (TypeError, ValueError):
        amount = 0.0
    return '%s|%s|%s|%s' % (obj.get('name') or '', _js_number(amount),
                            obj.get('category') or '', obj.get('dateStr') or '')


def extract_zip_image(conn, archive, info):
    """Stream one member out of the archive (never extractall), verifying that the bytes
    really hash to the name they claim — a poisoned zip must not get to serve arbitrary
    bytes under a hash the client trusts."""
    name = info.filename
    hash_hex = name[len('images/'):len('images/') + 64]
    ext = name.rsplit('.', 1)[-1].lower()
    if info.file_size > MAX_IMAGE:
        raise ApiError(413, 'image_too_large',
                       'archived image %s is %d bytes' % (name, info.file_size))
    dest = image_file_path(hash_hex, ext)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    tmp = '%s.%s.part' % (dest, secrets.token_hex(4))
    digest = hashlib.sha256()
    total = 0
    try:
        with archive.open(info) as src, open(tmp, 'wb') as out:
            while True:
                chunk = src.read(CHUNK)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_IMAGE:
                    raise ApiError(413, 'image_too_large',
                                   'archived image %s exceeds %d bytes' % (name, MAX_IMAGE))
                digest.update(chunk)
                out.write(chunk)
        if digest.hexdigest() != hash_hex:
            os.remove(tmp)
            return False  # content does not match its own address: drop it silently
        if os.path.exists(dest):
            os.remove(tmp)
        else:
            os.replace(tmp, dest)
    except BaseException:
        with contextlib.suppress(OSError):
            os.remove(tmp)
        raise
    conn.execute('INSERT INTO images(hash,mime,ext,bytes,created) VALUES(?,?,?,?,?) '
                 'ON CONFLICT(hash) DO NOTHING',
                 (hash_hex, MIME_BY_EXT.get(ext, 'application/octet-stream'), ext,
                  total, now_ms()))
    return True


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------


class SpendyHandler(BaseHTTPRequestHandler):
    server_version = 'Spendy/' + APP_VERSION
    sys_version = ''
    protocol_version = 'HTTP/1.1'
    timeout = IDLE_TIMEOUT

    # Defaults, so send_error() can run before _dispatch() ever set them (a malformed
    # request line is answered before the handler knows what it is looking at).
    _sent = False
    _head_only = False
    _status = 0
    _body_read = False
    _inflight_held = 0

    # (method, compiled path, handler attribute). First match wins; /api/records/bulk is
    # listed before /api/records/<id> and <id> is digits-only so they cannot collide.
    # <id> is bounded to 18 digits: `\d+` let /api/records/<4400 digits> reach int(), which
    # raises Python 3.11's digit-limit ValueError and leaked it as a 500 "internal".
    ROUTES = (
        ('GET', re.compile(r'^/api/health$'), 'api_health'),
        ('GET', re.compile(r'^/api/state$'), 'api_state'),
        ('GET', re.compile(r'^/api/fingerprints$'), 'api_fingerprints'),
        ('GET', re.compile(r'^/api/meta$'), 'api_meta_get'),
        ('PUT', re.compile(r'^/api/meta$'), 'api_meta_bulk'),
        ('PUT', re.compile(r'^/api/meta/(?P<key>.+)$'), 'api_meta_put'),
        ('POST', re.compile(r'^/api/records/bulk$'), 'api_records_bulk'),
        ('POST', re.compile(r'^/api/records$'), 'api_record_add'),
        ('DELETE', re.compile(r'^/api/records$'), 'api_records_wipe'),
        ('PUT', re.compile(r'^/api/records/(?P<id>[0-9]{1,18})$'), 'api_record_update'),
        ('DELETE', re.compile(r'^/api/records/(?P<id>[0-9]{1,18})$'), 'api_record_delete'),
        ('POST', re.compile(r'^/api/images$'), 'api_image_post'),
        ('GET', re.compile(r'^/api/images/(?P<hash>[^/]+)$'), 'api_image_get'),
        ('GET', re.compile(r'^/api/backup\.zip$'), 'api_backup_zip'),
        ('GET', re.compile(r'^/api/backup\.json$'), 'api_backup_json'),
        ('POST', re.compile(r'^/api/restore/stage$'), 'api_restore_stage'),
        ('POST', re.compile(r'^/api/restore/commit$'), 'api_restore_commit'),
        ('POST', re.compile(r'^/api/maintenance/gc-images$'), 'api_gc_images'),
    )

    # -- plumbing ----------------------------------------------------------

    def log_message(self, fmt, *args):
        pass  # we log one tidy line per request ourselves

    def log_request(self, *args, **kwargs):
        pass

    def log_error(self, fmt, *args):
        # Client disconnects are normal; do not turn them into stderr noise.
        with contextlib.suppress(Exception):
            log_line('WARN  %s' % (fmt % args))

    def handle_one_request(self):
        try:
            BaseHTTPRequestHandler.handle_one_request(self)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            self.close_connection = True

    def db(self):
        if getattr(self, '_conn', None) is None:
            self._conn = connect()
        return self._conn

    # -- CORS --------------------------------------------------------------

    def request_origin(self):
        """The Origin header, or '' — defensively, because send_error() can fire before
        the request headers were ever parsed."""
        headers = getattr(self, 'headers', None)
        if headers is None:
            return ''
        return (headers.get('Origin') or '').strip()

    def origin_allowed(self, origin):
        """Is this browser origin allowed to see (and to write) our responses?"""
        if not origin:
            return True          # no Origin: not a cross-origin browser request at all
        low = origin.lower().rstrip('/')
        if CORS_ANY or low in CORS_ORIGINS:
            return True
        if low == 'null':
            # file:// pages send this — but so does every sandboxed iframe, which any web
            # page can create. Not trustworthy without SPENDY_CORS_ANY=1.
            return False
        try:
            parts = urllib.parse.urlsplit(low)
        except ValueError:
            return False
        if (parts.hostname or '') in CORS_LOCAL_HOSTS:
            return True          # a dev server on the same machine
        headers = getattr(self, 'headers', None)
        host = ((headers.get('Host') if headers else '') or '').strip().lower()
        return bool(host) and parts.netloc == host      # same origin as this server

    def cors_headers(self):
        origin = self.request_origin()
        out = [('Access-Control-Allow-Methods', CORS_METHODS),
               ('Access-Control-Allow-Headers', CORS_ALLOW_HEADERS),
               ('Access-Control-Max-Age', CORS_MAX_AGE),
               ('Vary', 'Origin')]
        if not origin:
            out.insert(0, ('Access-Control-Allow-Origin', '*'))
        elif self.origin_allowed(origin):
            out.insert(0, ('Access-Control-Allow-Origin', origin))
        return out

    # -- response helpers --------------------------------------------------

    def _head(self, status, ctype, length, extra=None):
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(length))
        for key, value in self.cors_headers():
            self.send_header(key, value)
        for key, value in (extra or ()):
            self.send_header(key, value)
        if self.close_connection:
            # Say so explicitly when we are about to hang up (an undrained request body,
            # or an error raised by the base class) so a keep-alive client re-dials
            # instead of writing its next request into a socket we are closing.
            self.send_header('Connection', 'close')
        self.end_headers()
        self._status = status
        self._sent = True  # headers are out: a later failure may not write a second response

    def send_error(self, code, message=None, explain=None):
        """BaseHTTPRequestHandler answers an unknown verb, a malformed request line or an
        over-long URL with an HTML page carrying no CORS header at all. The contract says
        every non-2xx is `{ok:false,error,detail}` and every response carries CORS, so
        those paths are routed through the same JSON shape as everything else."""
        if self._sent:
            self.close_connection = True
            return
        self.close_connection = True
        if getattr(self, 'command', None) == 'HEAD':
            self._head_only = True
        if getattr(self, 'request_version', '') == 'HTTP/0.9':
            # A request line too broken to carry a version would otherwise get a bodiless
            # HTTP/0.9 reply (no status line, no headers). Answer in HTTP/1.1 so the caller
            # sees the documented JSON error instead of a mystery.
            self.request_version = 'HTTP/1.1'
        code = int(code)      # HTTPStatus is an Enum: it does NOT hash as its int value
        detail = message or explain or ''
        with contextlib.suppress(BrokenPipeError, ConnectionResetError, OSError):
            self.send_error_json(code, ERROR_SLUGS.get(code, 'http_%d' % code), str(detail))

    def send_json(self, status, payload, extra_headers=None):
        body = dumps(payload)
        self._head(status, 'application/json; charset=utf-8', len(body), extra_headers)
        if not self._head_only:
            self.wfile.write(body)

    def send_error_json(self, status, error, detail='', extra=None):
        payload = {'ok': False, 'error': error, 'detail': detail}
        if extra:
            payload.update(extra)
        self.send_json(status, payload)

    def send_file(self, path, ctype, extra_headers=None):
        size = os.path.getsize(path)
        self._head(200, ctype, size, extra_headers)
        if self._head_only:
            return
        with open(path, 'rb') as handle:
            shutil.copyfileobj(handle, self.wfile, CHUNK)  # never .read() a whole file

    # -- request body ------------------------------------------------------

    def _body_chunks(self, cap=MAX_BODY):
        """Yields the body in pieces. Content-Length is the normal path; chunked is
        supported because a streaming fetch() would otherwise be unreadable."""
        encoding = (self.headers.get('Transfer-Encoding') or '').lower()
        if 'chunked' in encoding:
            total = 0
            while True:
                line = self.rfile.readline(65536).strip()
                if b';' in line:
                    line = line.split(b';', 1)[0]
                try:
                    size = int(line, 16)
                except ValueError:
                    raise ApiError(400, 'bad_chunk', 'malformed chunked body')
                if size == 0:
                    while True:
                        trailer = self.rfile.readline(65536)
                        if trailer in (b'\r\n', b'\n', b''):
                            break
                    self._body_read = True
                    return
                total += size
                if total > cap:
                    raise ApiError(413, 'body_too_large', 'body exceeds %d bytes' % cap)
                left = size
                while left:
                    piece = self.rfile.read(min(CHUNK, left))
                    if not piece:
                        raise ApiError(400, 'truncated_body', 'connection closed mid-body')
                    left -= len(piece)
                    yield piece
                self.rfile.read(2)  # trailing CRLF
            return
        raw_length = self.headers.get('Content-Length')
        if raw_length is None:
            self._body_read = True     # nothing was sent, so nothing is left on the socket
            return
        try:
            length = int(raw_length)
        except ValueError:
            raise ApiError(400, 'bad_length', 'Content-Length is not a number')
        if length < 0:
            raise ApiError(400, 'bad_length', 'Content-Length is negative')
        if length > cap:
            raise ApiError(413, 'body_too_large', 'body exceeds %d bytes' % cap)
        left = length
        while left > 0:
            piece = self.rfile.read(min(CHUNK, left))
            if not piece:
                raise ApiError(400, 'truncated_body', 'connection closed mid-body')
            left -= len(piece)
            yield piece
        self._body_read = True

    def read_body(self, limit=None):
        """The body as bytes, grown as it ARRIVES.

        It used to be `bytearray(Content-Length)` up front. That let a client reserve
        memory it never intends to send: six sockets announcing 400 MB and then sending one
        byte each took RSS from 32 MB to 2.4 GB and held it until the idle timeout, for
        about 200 bytes of traffic. With no auth and a LAN-reachable port, that is a free
        OOM kill. Now memory tracks bytes actually received, a per-endpoint ceiling applies
        (JSON endpoints are far below MAX_BODY), and a process-wide budget stops parallel
        uploads from multiplying it."""
        cap = MAX_BODY if limit is None else min(limit, MAX_BODY)
        buffer = bytearray()
        for piece in self._body_chunks(cap):
            self._inflight_held += inflight_take(len(piece))
            buffer += piece
            if len(buffer) > cap:      # chunked bodies only know their size as they arrive
                raise ApiError(413, 'body_too_large', 'body exceeds %d bytes' % cap)
        return buffer

    def read_json(self, limit=MAX_JSON_BODY):
        raw = self.read_body(limit)
        if not raw:
            raise ApiError(400, 'empty_body', 'expected a JSON body')
        try:
            return json.loads(raw)  # json.loads takes bytes/bytearray: no extra decode copy
        except ValueError as exc:
            raise ApiError(400, 'bad_json', 'body is not valid JSON: %s' % exc)

    def stream_body_to(self, dest):
        """Restore uploads go straight to disk — a 61 MB zip must never be buffered.
        No in-memory budget here for exactly that reason; the ceiling is disk (STAGE_BUDGET)."""
        total = 0
        with open(dest, 'wb') as out:
            for chunk in self._body_chunks(MAX_BODY):
                out.write(chunk)
                total += len(chunk)
        return total

    # -- dispatch ----------------------------------------------------------

    def do_GET(self):
        self._dispatch('GET')

    def do_HEAD(self):
        self._dispatch('GET', head_only=True)

    def do_POST(self):
        self._dispatch('POST')

    def do_PUT(self):
        self._dispatch('PUT')

    def do_DELETE(self):
        self._dispatch('DELETE')

    def do_PATCH(self):
        # Not a method this API uses, but naming it routes the request through _dispatch,
        # which answers with the JSON 405/404 contract instead of the base class's HTML.
        self._dispatch('PATCH')

    def do_TRACE(self):
        self._dispatch('TRACE')

    def do_OPTIONS(self):
        self._head_only = False
        self._sent = False
        self._status = 204
        started = time.perf_counter()
        try:
            self.send_response(204)
            for key, value in self.cors_headers():
                self.send_header(key, value)
            self.send_header('Content-Length', '0')
            self.end_headers()
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
            return
        # A preflight from an origin we do not trust simply carries no
        # Access-Control-Allow-Origin, so the browser refuses to send the real request.
        self._log_request(204, started)

    def _dispatch(self, method, head_only=False):
        started = time.perf_counter()
        self._head_only = head_only
        self._status = 0
        self._sent = False
        self._conn = None
        self._body_read = False
        self._inflight_held = 0
        try:
            origin = self.request_origin()
            if method in MUTATING_METHODS and origin and not self.origin_allowed(origin):
                # Reading is already blocked by the missing CORS header, but a cross-site
                # write does not need to read the response to do damage — a page can fire
                # a POST/DELETE and never look at the result. Refuse it server-side.
                raise ApiError(403, 'forbidden_origin',
                               'cross-site %s from %s is not allowed (set SPENDY_CORS_ANY=1 '
                               'only for development)' % (method, origin[:100]))
            split = urllib.parse.urlsplit(self.path)
            path = urllib.parse.unquote(split.path)
            self.query = urllib.parse.parse_qs(split.query)
            handler = None
            path_matched = False
            for route_method, pattern, attr in self.ROUTES:
                match = pattern.match(path)
                if not match:
                    continue
                path_matched = True
                if route_method == method:
                    handler = (getattr(self, attr), match)
                    break
            shown = path if len(path) <= 120 else path[:117] + '...'   # never echo a 4 KB URL
            if handler:
                handler[0](handler[1])
            elif path_matched:
                raise ApiError(405, 'method_not_allowed', '%s is not allowed on %s' % (method, shown))
            elif path.startswith('/api/'):
                raise ApiError(404, 'not_found', 'no such endpoint: %s' % shown)
            elif method == 'GET':
                self.serve_static(path)
            else:
                raise ApiError(405, 'method_not_allowed', '%s is not allowed on %s' % (method, shown))
        except ApiError as exc:
            if self._sent:
                self.close_connection = True  # too late to say anything useful
            else:
                # 413/400 are raised BEFORE the body is read (that is the point of the
                # ceiling). Those unread bytes are still queued on a keep-alive socket and
                # would be parsed as the next request line — answering a request the client
                # never made. Hang up instead.
                if self._body_pending():
                    self.close_connection = True
                with contextlib.suppress(BrokenPipeError, ConnectionResetError):
                    self.send_error_json(exc.status, exc.error, exc.detail, exc.extra)
        except (BrokenPipeError, ConnectionResetError):
            # The browser navigated away mid-response. Nothing to say, nobody to say it to.
            self.close_connection = True
            self._status = 499
        except Exception as exc:
            traceback.print_exc()
            if self._sent:
                self.close_connection = True
            else:
                if self._body_pending():
                    self.close_connection = True
                with contextlib.suppress(BrokenPipeError, ConnectionResetError):
                    self.send_error_json(500, 'internal', '%s: %s' % (type(exc).__name__, exc))
        finally:
            inflight_release(self._inflight_held)
            self._inflight_held = 0
            if getattr(self, '_conn', None) is not None:
                with contextlib.suppress(Exception):
                    self._conn.close()
                self._conn = None
            self._log_request(self._status or 500, started)

    def _body_pending(self):
        """True when the client announced a body we never took off the socket."""
        if self._body_read:
            return False
        headers = getattr(self, 'headers', None)
        if headers is None:
            return False
        if 'chunked' in (headers.get('Transfer-Encoding') or '').lower():
            return True
        try:
            return int(headers.get('Content-Length') or 0) > 0
        except ValueError:
            return True

    def _log_request(self, status, started):
        """One line per request so `docker logs` is useful. Bodies are NEVER logged —
        they carry card numbers and attachment bytes."""
        elapsed = (time.perf_counter() - started) * 1000.0
        target = self.path if len(self.path) <= 120 else self.path[:117] + '...'
        log_line('%-6s %-46s %3d %6.0fms' % (self.command or '-', target, status, elapsed))

    # -- endpoints: read ---------------------------------------------------

    def api_health(self, match):
        conn = self.db()
        records = conn.execute('SELECT COUNT(*) AS n FROM records').fetchone()['n']
        images = conn.execute('SELECT COUNT(*) AS n FROM images').fetchone()['n']
        db_bytes = 0
        for suffix in ('', '-wal'):  # under WAL the newest writes still live in the -wal file
            with contextlib.suppress(OSError):
                db_bytes += os.path.getsize(DB_PATH + suffix)
        self.send_json(200, {'ok': True, 'records': records, 'images': images,
                             'dbBytes': db_bytes, 'version': APP_VERSION})

    def api_state(self, match):
        conn = self.db()
        records = [row_to_record(r) for r in
                   conn.execute('SELECT * FROM records ORDER BY id').fetchall()]
        self.send_json(200, {'ok': True, 'records': records, 'meta': read_meta(conn)})

    def api_fingerprints(self, match):
        conn = self.db()
        rows = conn.execute('SELECT fingerprint FROM records').fetchall()
        self.send_json(200, {'ok': True, 'fingerprints': [r['fingerprint'] for r in rows]})

    def api_meta_get(self, match):
        self.send_json(200, {'ok': True, 'meta': read_meta(self.db())})

    # -- endpoints: records ------------------------------------------------

    def api_record_add(self, match):
        obj = self.read_json()
        conn = self.db()
        with write_tx(conn):
            values = record_from_json(obj, conn)
            new_id = insert_record(conn, values)
            if new_id is None:
                existing = conn.execute('SELECT id FROM records WHERE fingerprint=?',
                                        (values[9],)).fetchone()
                raise ApiError(409, 'duplicate', 'a record with this fingerprint already exists',
                               {'id': existing['id'] if existing else None})
        self.send_json(201, {'ok': True, 'record': values_to_record(values, new_id)})

    def api_record_update(self, match):
        row_id = int(match.group('id'))
        obj = self.read_json()
        conn = self.db()
        with write_tx(conn):
            if conn.execute('SELECT id FROM records WHERE id=?', (row_id,)).fetchone() is None:
                raise ApiError(404, 'not_found', 'no record with id %d' % row_id)
            values = record_from_json(obj, conn)
            clash = conn.execute('SELECT id FROM records WHERE fingerprint=? AND id<>?',
                                 (values[9], row_id)).fetchone()
            if clash is not None:
                raise ApiError(409, 'duplicate',
                               'another record already has this fingerprint',
                               {'id': clash['id']})
            conn.execute(UPDATE_SQL, values + (row_id,))
        self.send_json(200, {'ok': True, 'record': values_to_record(values, row_id)})

    def api_record_delete(self, match):
        row_id = int(match.group('id'))
        conn = self.db()
        with write_tx(conn):
            cur = conn.execute('DELETE FROM records WHERE id=?', (row_id,))
            deleted = cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0
        self.send_json(200, {'ok': True, 'deleted': deleted})

    def api_records_bulk(self, match):
        """The one transactional write: CSV import, restore-commit and the legacy
        installment merge all land here. Deletes first, then inserts; duplicates are
        skipped, anything else rolls the whole thing back."""
        body = self.read_json()
        if not isinstance(body, dict):
            raise ApiError(400, 'bad_request', 'body must be {add:[…], deleteIds:[…]}')
        if body.get('replaceAll') is not None:
            return self.records_replace_all(body)
        add = body.get('add') or []
        delete_ids = body.get('deleteIds') or []
        if not isinstance(add, list) or not isinstance(delete_ids, list):
            raise ApiError(400, 'bad_request', '"add" and "deleteIds" must be arrays')
        conn = self.db()
        added = duplicates = deleted = 0
        inserted = []
        with write_tx(conn):
            for raw_id in delete_ids:
                try:
                    row_id = int(raw_id)
                except (TypeError, ValueError):
                    continue
                cur = conn.execute('DELETE FROM records WHERE id=?', (row_id,))
                if cur.rowcount and cur.rowcount > 0:
                    deleted += cur.rowcount
            for obj in add:
                values = record_from_json(obj, conn)
                new_id = insert_record(conn, values)
                if new_id is None:
                    duplicates += 1
                    continue
                added += 1
                inserted.append(values_to_record(values, new_id))
        self.send_json(200, {'ok': True, 'added': added, 'duplicates': duplicates,
                             'deleted': deleted, 'records': inserted})

    def records_replace_all(self, body):
        """Swap the whole table inside one transaction, preserving ids.

        A category rename rewrites the fingerprint of many rows at once. Updating them one
        by one would collide with the unique index halfway through (row A taking the
        fingerprint row B still holds), so the client hands over the complete post-rename
        set and we delete-then-insert. Readers never see the empty table — it only exists
        inside the transaction — and a failure anywhere rolls the original rows back.

        COMPARE-AND-SWAP, not a blind swap. The payload is built from whatever snapshot the
        calling tab last read. A blind DELETE therefore erases anything a second device
        added since: phone adds a transaction, laptop renames a category, the transaction
        is gone with a cheerful 200 and nothing in the log. So before deleting anything we
        check that every row in the table is accounted for by the payload; if it is not,
        the caller is working from an outdated view and gets 409 stale_snapshot.

        "Accounted for" is not just "its id is in the payload": the client legitimately
        DROPS rows that become identical after a rename (the merge case — it reports
        "merged N duplicates"). A dropped row is recognisable because a row it merged into
        is in the payload, and equal fingerprints mean equal name+amount+dateStr. So a
        missing id is fine when some payload row shares those three fields, and only a row
        that matches nothing at all — i.e. one this caller never saw — blocks the swap."""
        rows = body.get('replaceAll')
        if not isinstance(rows, list):
            raise ApiError(400, 'bad_request', '"replaceAll" must be an array of records')
        if body.get('add') or body.get('deleteIds'):
            raise ApiError(400, 'bad_request', '"replaceAll" cannot be combined with add/deleteIds')
        if not rows:
            # Refuse the one shape that is almost certainly a bug rather than intent —
            # wiping every transaction has its own explicit endpoint.
            raise ApiError(400, 'bad_request', 'refusing to replace every record with an empty set; use DELETE /api/records')

        payload_ids = set()
        payload_keys = set()
        for obj in rows:
            if not isinstance(obj, dict):
                raise ApiError(400, 'bad_record', 'replaceAll entries must be JSON objects')
            raw_id = obj.get('id')
            if raw_id is not None:
                try:
                    payload_ids.add(int(raw_id))
                except (TypeError, ValueError):
                    raise ApiError(400, 'bad_request',
                                   'replaceAll entries must carry their integer id')
            payload_keys.add(_identity_key(obj))

        conn = self.db()
        try:
            with write_tx(conn):
                strangers = 0
                sample = ''
                for row in conn.execute('SELECT id,name,amount,dateStr FROM records'):
                    if row['id'] in payload_ids:
                        continue
                    if (row['name'], float(row['amount'] or 0), row['dateStr']) in payload_keys:
                        continue      # merged into a row the caller kept
                    strangers += 1
                    if not sample:
                        sample = '%s (%s)' % (row['name'] or '?', row['dateStr'] or '?')
                if strangers:
                    raise ApiError(409, 'stale_snapshot',
                                   '%d record(s) changed on the server since this page loaded '
                                   '(e.g. %s) — reload and try again' % (strangers, sample))
                conn.execute('DELETE FROM records')
                for obj in rows:
                    values = record_from_json(obj, conn)
                    raw_id = obj.get('id')
                    row_id = int(raw_id) if raw_id is not None else None
                    conn.execute(REPLACE_INSERT_SQL, (row_id,) + values)
        except sqlite3.IntegrityError as exc:
            # Rolled back: the caller sent two rows sharing a fingerprint (or an id).
            raise ApiError(409, 'duplicate', 'replaceAll contains a duplicate: %s' % exc)
        self.send_json(200, {'ok': True, 'replaced': len(rows)})

    def api_records_wipe(self, match):
        wipe_meta = (self.query.get('meta', ['0'])[0] or '0').lower() in ('1', 'true', 'yes')
        conn = self.db()
        with write_tx(conn):
            cur = conn.execute('DELETE FROM records')
            deleted = cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0
            if wipe_meta:
                conn.execute('DELETE FROM meta')
        # Image files stay on disk; gc-images reclaims them once the user is sure.
        self.send_json(200, {'ok': True, 'deleted': deleted})

    # -- endpoints: meta ---------------------------------------------------

    def api_meta_put(self, match):
        key = match.group('key')
        body = self.read_json()
        if not isinstance(body, dict) or 'value' not in body:
            raise ApiError(400, 'bad_request', 'body must be {"value": …} (null deletes)')
        conn = self.db()
        with write_tx(conn):
            write_meta(conn, key, body['value'])
        self.send_json(200, {'ok': True})

    def api_meta_bulk(self, match):
        body = self.read_json()
        meta = body.get('meta') if isinstance(body, dict) else None
        if not isinstance(meta, dict):
            raise ApiError(400, 'bad_request', 'body must be {"meta": {key: value, …}}')
        conn = self.db()
        written = 0
        with write_tx(conn):
            for key, value in meta.items():
                if write_meta(conn, key, value):
                    written += 1
        self.send_json(200, {'ok': True, 'written': written})

    # -- endpoints: images -------------------------------------------------

    def api_image_get(self, match):
        hash_hex = match.group('hash')
        # Validate BEFORE the path is built. Never let unvalidated input reach the fs.
        if not RE_HASH.match(hash_hex):
            raise ApiError(404, 'not_found', 'malformed image hash')
        found = resolve_image(self.db(), hash_hex)
        if not found:
            raise ApiError(404, 'not_found', 'no image with that hash')
        path, mime, ext = found
        mime = mime or 'application/octet-stream'
        if ext == 'svg' or 'svg' in mime:
            # An SVG is a document: opened directly (not through <img>) it executes its
            # own script ON THIS ORIGIN, where /api/state hands out card numbers — and the
            # bytes are cached as immutable for a year. Receipts are photos; nothing in the
            # app needs an SVG attachment to render, so it is served as an opaque blob.
            mime = 'application/octet-stream'
        self.send_file(path, mime, [
            ('Cache-Control', 'public, max-age=31536000, immutable'),
            ('X-Content-Type-Options', 'nosniff'),
            ('Content-Security-Policy', "default-src 'none'; sandbox"),
        ])

    def api_image_post(self, match):
        body = self.read_json()
        data = body.get('data') if isinstance(body, dict) else None
        conn = self.db()
        with write_tx(conn):
            hash_hex = normalize_image(data, conn)
        if not hash_hex:
            raise ApiError(400, 'bad_image', 'expected {"data": "data:<mime>;base64,…"}')
        self.send_json(200, {'ok': True, 'hash': hash_hex, 'url': '/api/images/' + hash_hex})

    # -- endpoints: backup -------------------------------------------------

    def api_backup_json(self, match):
        payload = build_backup_payload(self.db())
        stamp = time.strftime('%Y-%m-%d')
        self.send_json(200, payload, [
            ('Content-Disposition', 'attachment; filename="spendy-backup-%s.json"' % stamp),
            ('Cache-Control', 'no-store'),
        ])

    def api_backup_zip(self, match):
        """Assembled on disk, not in RAM: zipfile.write() streams each attachment through
        a small buffer, so a 61 MB archive costs a few hundred KB of memory."""
        conn = self.db()
        payload = build_backup_payload(conn)
        wanted = {r['image'] for r in
                  conn.execute('SELECT DISTINCT image FROM records '
                               'WHERE image IS NOT NULL AND image <> ""').fetchall()}
        tmp_path = os.path.join(TMP_DIR, 'backup-%s.zip' % secrets.token_hex(8))
        try:
            with zipfile.ZipFile(tmp_path, 'w', allowZip64=True) as archive:
                archive.writestr('spendy-backup.json', dumps(payload),
                                 compress_type=zipfile.ZIP_DEFLATED)
                for hash_hex in sorted(h for h in wanted if h and RE_HASH.match(h)):
                    found = resolve_image(conn, hash_hex)
                    if not found:
                        continue  # record points at bytes we no longer have; skip quietly
                    path, _mime, ext = found
                    archive.write(path, 'images/%s.%s' % (hash_hex, ext),
                                  compress_type=zipfile.ZIP_STORED)  # already compressed
            stamp = time.strftime('%Y-%m-%d')
            self.send_file(tmp_path, 'application/zip', [
                ('Content-Disposition', 'attachment; filename="spendy-backup-%s.zip"' % stamp),
                ('Cache-Control', 'no-store'),
            ])
        finally:
            with contextlib.suppress(OSError):
                os.remove(tmp_path)

    # -- endpoints: restore ------------------------------------------------

    def api_restore_stage(self, match):
        sweep_tmp()
        client = self.client_address[0] if self.client_address else ''
        # Every file the user picks in the restore dialog is staged, including the ones
        # they immediately cancel. Without this, ten stage calls parked up to 5 GB in a
        # Docker volume nobody sized for it, and the sweeper could not touch any of it for
        # STAGE_TTL. One live upload per caller, plus a hard budget for the whole area.
        drop_previous_staged(client)
        used = tmp_usage()
        if used >= STAGE_BUDGET:
            raise ApiError(507, 'staging_full',
                           'the restore staging area holds %d bytes (limit %d); '
                           'retry in a few minutes' % (used, STAGE_BUDGET))
        token = secrets.token_hex(16)
        staged = os.path.join(TMP_DIR, token)
        archive = None
        staged_ok = False
        try:
            size = self.stream_body_to(staged)
            if not size:
                raise ApiError(400, 'empty_body', 'no file uploaded')
            payload, archive = open_staged(staged)
            records = staged_records(payload)
            conn = self.db()
            existing = {r['fingerprint'] for r in
                        conn.execute('SELECT fingerprint FROM records').fetchall()}
            fresh = duplicates = 0
            seen = set()
            # DISTINCT attachments, not records-carrying-an-attachment. For a zip this
            # counts images/ members; counting one per record instead made the same backup
            # report a different number as .json than as .zip (three records sharing one
            # photo said 3), and the client renders the figure verbatim.
            inline_images = set()
            for obj in records:
                fingerprint = record_fingerprint_for_preview(obj)
                if isinstance(obj, dict):
                    image = obj.get('image')
                    if isinstance(image, str) and image.strip():
                        inline_images.add(image.strip())
                if fingerprint in existing or fingerprint in seen:
                    duplicates += 1
                else:
                    seen.add(fingerprint)
                    fresh += 1
            if archive is not None:
                images = sum(1 for info in archive.infolist()
                             if RE_ZIP_IMAGE.match(info.filename))
                archive.close()   # close before anyone may want to delete the staged file
                archive = None
            else:
                images = len(inline_images)
            staged_ok = True      # the file now waits for /restore/commit or the sweeper
            remember_staged(client, token)
            self.send_json(200, {
                'ok': True, 'token': token, 'total': len(records), 'fresh': fresh,
                'duplicates': duplicates, 'metaKeys': staged_meta_keys(payload),
                'records': len(records), 'images': images,
            })
        finally:
            if archive is not None:
                archive.close()
            if not staged_ok:
                with contextlib.suppress(OSError):
                    os.remove(staged)

    def api_restore_commit(self, match):
        body = self.read_json()
        token = body.get('token') if isinstance(body, dict) else None
        if not isinstance(token, str) or not RE_TOKEN.match(token):
            raise ApiError(400, 'bad_token', 'token must be the 32-hex value from /restore/stage')
        staged = os.path.join(TMP_DIR, token)
        if not os.path.isfile(staged):
            raise ApiError(404, 'unknown_token', 'no staged upload for that token (expired?)')
        conn = self.db()
        archive = None
        added = duplicates = meta_written = 0
        try:
            payload, archive = open_staged(staged)
            records = staged_records(payload)
            with write_tx(conn):
                if archive is not None:
                    for info in archive.infolist():
                        if RE_ZIP_IMAGE.match(info.filename):
                            extract_zip_image(conn, archive, info)
                for obj in records:
                    values = record_from_json(obj, conn, allow_fp_fallback=True)
                    if insert_record(conn, values) is None:
                        duplicates += 1   # additive merge: existing rows are never touched
                    else:
                        added += 1
                if isinstance(payload, dict):
                    for key in staged_meta_keys(payload):
                        if write_meta(conn, key, payload[key]):
                            meta_written += 1
        finally:
            if archive is not None:
                archive.close()
        with contextlib.suppress(OSError):
            os.remove(staged)
        forget_staged(token)
        sweep_tmp()     # also here, not only on stage: an abandoned upload should not wait
                        # for the user to happen to open the restore dialog again
        self.send_json(200, {'ok': True, 'added': added, 'duplicates': duplicates,
                             'metaWritten': meta_written})

    # -- endpoints: maintenance -------------------------------------------

    def api_gc_images(self, match):
        conn = self.db()
        removed = 0
        freed = 0
        with write_tx(conn):
            referenced = {r['image'] for r in
                          conn.execute('SELECT DISTINCT image FROM records '
                                       'WHERE image IS NOT NULL').fetchall()}
            for shard in sorted(os.listdir(IMG_DIR) if os.path.isdir(IMG_DIR) else []):
                shard_path = os.path.join(IMG_DIR, shard)
                if not os.path.isdir(shard_path):
                    continue
                for name in sorted(os.listdir(shard_path)):
                    base = name.split('.', 1)[0]
                    if not RE_HASH.match(base) or base in referenced:
                        continue
                    path = os.path.join(shard_path, name)
                    try:
                        size = os.path.getsize(path)
                        os.remove(path)
                    except OSError:
                        continue
                    removed += 1
                    freed += size
                    conn.execute('DELETE FROM images WHERE hash=?', (base,))
                with contextlib.suppress(OSError):
                    os.rmdir(shard_path)  # only succeeds when the shard emptied out
        self.send_json(200, {'ok': True, 'removed': removed, 'freedBytes': freed})

    # -- static files ------------------------------------------------------

    def serve_static(self, path):
        """Read-only hosting of SPENDY_APP_DIR. Everything about this is deny-by-default:
        segment check first, then an ALLOW-list of the files the app actually ships,
        extension whitelist, and realpath containment last."""
        rel = path.lstrip('/')
        if rel in ('', '/'):
            rel = 'Spendy.html'
        parts = re.split(r'[\\/]+', rel)
        if not parts or any(part.startswith('.') or part == '' for part in parts):
            raise ApiError(404, 'not_found', 'not found')       # blocks .. and dotfiles
        ext = os.path.splitext(parts[-1])[1].lower()
        if ext not in STATIC_TYPES:
            raise ApiError(404, 'not_found', 'not found')
        # Either one of the app's own files at the root, or one level deep inside a directory
        # we ship (vendor/). Anything else in SPENDY_APP_DIR stays private — see STATIC_FILES.
        if len(parts) == 1:
            allowed = parts[0].lower() in STATIC_FILES
        else:
            allowed = len(parts) == 2 and parts[0].lower() in STATIC_DIRS
        if not allowed:
            raise ApiError(404, 'not_found', 'not found')
        full = os.path.realpath(os.path.join(APP_ROOT, *parts))  # resolves symlinks too
        if full != APP_ROOT and not full.startswith(APP_ROOT + os.sep):
            raise ApiError(404, 'not_found', 'not found')
        if not os.path.isfile(full):
            raise ApiError(404, 'not_found', 'not found')
        cache = 'no-cache' if ext in STATIC_NO_CACHE else 'public, max-age=86400'
        self.send_file(full, STATIC_TYPES[ext], [('Cache-Control', cache)])


class SpendyServer(ThreadingHTTPServer):
    daemon_threads = True
    # SO_REUSEADDR means two different things. On Linux (the deployment target) it only
    # lets a restart re-bind a port still in TIME_WAIT — exactly what we want between
    # `docker compose up` cycles. On Windows it additionally lets a SECOND live listener
    # bind a port that is already bound, and connections are then split nondeterministically
    # between the processes: two developers on one box silently serve each other's
    # requests instead of getting EADDRINUSE. So: on, except on Windows.
    allow_reuse_address = (os.name != 'nt')
    request_queue_size = 64


def main():
    # Logs and payloads are Vietnamese; do not let a legacy console codepage decide that.
    with contextlib.suppress(Exception):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    init_db()
    server = SpendyServer((HOST, PORT), SpendyHandler)

    # `docker stop` sends SIGTERM. With no handler the process is killed outright:
    # serve_forever() never returns, server_close() never runs, and a client halfway
    # through a 61 MB restore just loses the connection during a routine redeploy.
    # shutdown() must not be called from the handler itself — it waits for serve_forever's
    # loop, which is the thread the handler interrupts — hence the thread.
    def _terminate(_signum, _frame):
        log_line('SIGTERM - draining')
        threading.Thread(target=server.shutdown, daemon=True).start()

    with contextlib.suppress(Exception):
        signal.signal(signal.SIGTERM, _terminate)

    shown = '127.0.0.1' if HOST in ('0.0.0.0', '::', '') else HOST
    log_line('Spendy %s - data=%s app=%s' % (APP_VERSION, DATA_DIR, APP_DIR))
    log_line('listening on http://%s:%d/  (bind %s)' % (shown, PORT, HOST))
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        log_line('shutting down')
        server.server_close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
