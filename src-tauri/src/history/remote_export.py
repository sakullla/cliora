"""Read-only, bounded history export. All CLI paths/SQL come from adapter metadata."""
import base64
import fnmatch
import gzip
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import signal
import stat
import sys
import tempfile

def interrupted(number, _frame):
    raise SystemExit(128 + number)


for signal_name in ("SIGTERM", "SIGHUP"):
    if hasattr(signal, signal_name):
        signal.signal(getattr(signal, signal_name), interrupted)


spec = json.loads(base64.b64decode(sys.argv[1]))
previous = sys.argv[2]
home = Path.home()
root = home / spec["relative"]
for relative in [spec["relative"]] + spec["fallbacks"]:
    candidate = home / relative
    probe = candidate / spec["sqlite"]["index"] if spec.get("sqlite") else candidate
    try:
        probe.lstat()
        root = candidate
        break
    except FileNotFoundError:
        pass
file_cap = 12 * 1024 * 1024
archive_cap = 48 * 1024 * 1024
session_cap = 60
files = {}
revisions = {}
partial = set()
unread = set()


def checked(path, optional=False):
    path.relative_to(root)  # Every read stays inside the adapter's declared history root.
    relative = path.relative_to(home)
    current = home
    for part in relative.parts:
        if part in ("", ".", ".."):
            raise ValueError("invalid history path")
        current = current / part
        try:
            info = current.lstat()
        except FileNotFoundError:
            if optional:
                return None
            raise
        if stat.S_ISLNK(info.st_mode):
            raise ValueError("history source is a symbolic link")
    return info


def stamp(path):
    info = checked(path, True)
    key = str(path.relative_to(home))
    revisions[key] = None if info is None else [info.st_size, info.st_mtime_ns, info.st_ctime_ns]
    return info


def add(path, database=False):
    info = stamp(path)
    if info is None:
        return
    if not stat.S_ISREG(info.st_mode):
        raise ValueError("history source is not a regular file")
    files[str(Path(spec["relative"]) / path.relative_to(root))] = (path, database, info.st_size)
    if database:
        stamp(Path(str(path) + "-wal"))


def failed_directory_read(error):
    raise error


def quote(name):
    return '"' + name.replace('"', '""') + '"'


def open_db(path):
    checked(path)
    checked(Path(str(path) + "-wal"), True)
    db = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=0.5)
    if hasattr(db, "setlimit"):
        db.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, file_cap)
    db.execute("PRAGMA query_only=ON")
    db.execute("BEGIN")
    return db


def columns(db, table):
    return list(db.execute("PRAGMA table_info(" + quote(table) + ")"))


def selected_tables(db, declarations):
    ids = set()
    selected = []
    seen = set()
    for declaration in declarations:
        name = declaration["name"]
        cols = columns(db, name)
        names = [row[1] for row in cols]
        if name in seen or not cols or not set(declaration["required_columns"]) <= set(names):
            continue
        if declaration["link"]:
            selected.append((declaration, cols, None))
        else:
            rows = []
            cursor = db.execute(declaration["query"], {"limit": session_cap})
            projected = [column[0] for column in cursor.description]
            original = {row[1]: row for row in cols}
            cols = [original.get(name, (index, name, "", 0, None, 0)) for index, name in enumerate(projected)]
            names = projected
            for row in cursor:
                rows.append(row)
                if len(rows) > 20000:
                    raise ValueError("history index exceeds row limit")
                if declaration["id"]:
                    value = row[names.index(declaration["id"])]
                    if isinstance(value, str) and value and len(value) <= 256 and all(
                        ch.isascii() and (ch.isalnum() or ch in "_-.") for ch in value
                    ) and value not in (".", ".."):
                        ids.add(value)
            selected.append((declaration, cols, rows))
        seen.add(name)
    if not any(declaration["id"] for declaration, _, _ in selected):
        raise ValueError("history database schema is not supported")
    return ids, selected


def copy_table(source, output, declaration, cols, rows, ids):
    name = declaration["name"]
    names = [row[1] for row in cols]
    output.execute("CREATE TABLE " + quote(name) + " (" + ",".join(map(quote, names)) + ")")
    if rows is None:
        if not ids:
            return
        rows = source.execute(
            "SELECT * FROM " + quote(name) + " WHERE " + quote(declaration["link"])
            + " IN (" + ",".join("?" for _ in ids) + ")"
            + (" AND (" + declaration["query"] + ")" if declaration["query"] else "")
            + " ORDER BY rowid", sorted(ids)
        )
    count = 0
    total_bytes = 0
    batch_bytes = 0
    batch = []
    insert = "INSERT INTO " + quote(name) + " VALUES (" + ",".join("?" for _ in names) + ")"
    for row in rows:
        row_bytes = sum(len(value.encode("utf-8")) if isinstance(value, str) else len(value) if isinstance(value, bytes) else 8 for value in row)
        total_bytes += row_bytes
        batch_bytes += row_bytes
        if total_bytes > file_cap:
            raise ValueError("history database snapshot exceeds byte limit")
        batch.append(row)
        count += 1
        if count > 250000:
            raise ValueError("history database exceeds row limit")
        if len(batch) >= 128 or batch_bytes >= 1024 * 1024:
            output.executemany(insert, batch)
            batch.clear()
            batch_bytes = 0
            if output.execute("PRAGMA page_count").fetchone()[0] * 4096 > file_cap:
                raise ValueError("history database snapshot exceeds byte limit")
    if batch:
        output.executemany(insert, batch)
    # Preserve fast id lookups and session joins without copying arbitrary schema SQL.
    indexed = [row[1] for row in cols if row[5]]
    if declaration.get("id"):
        indexed.append(declaration["id"])
    if declaration["link"]:
        indexed.append(declaration["link"])
    for index, column in enumerate(dict.fromkeys(indexed)):
        output.execute("CREATE INDEX " + quote(name + "_history_" + str(index))
                       + " ON " + quote(name) + " (" + quote(column) + ")")


def snapshot_db(source, destination, selection=None, ids=None):
    output = sqlite3.connect(destination)
    output.execute("PRAGMA page_size=4096")
    try:
        if selection is None:
            selection = []
            for table in spec["sqlite"]["file_tables"]:
                cols = columns(source, table)
                if cols:
                    selection.append(({"name": table, "link": None}, cols,
                                      source.execute("SELECT * FROM " + quote(table) + " ORDER BY rowid")))
        for declaration, cols, rows in selection:
            copy_table(source, output, declaration, cols, rows, ids or set())
        output.commit()
    finally:
        output.close()
    if destination.stat().st_size > file_cap:
        raise ValueError("history database snapshot exceeds byte limit")


source_db = None
selection = None
ids = set()
info = checked(root, True)
if info is not None:
    if not stat.S_ISDIR(info.st_mode):
        raise ValueError("history root is not a directory")
    database = spec.get("sqlite")
    if database:
        path = root / database["index"]
        add(path, True)
        if files:
            source_db = open_db(path)
            ids, selection = selected_tables(source_db, database["tables"])
            for identity in sorted(ids):
                for template in database["files"]:
                    path = root / template.replace("{id}", identity)
                    add(path, path.suffix == ".db")
    else:
        candidates = []
        walked = 0
        for directory, dirs, names in os.walk(root, followlinks=False, onerror=failed_directory_read):
            dirs[:] = sorted(name for name in dirs if not (Path(directory) / name).is_symlink())
            for name in names:
                walked += 1
                if walked > 100000:
                    raise ValueError("history tree exceeds discovery limit")
                path = Path(directory) / name
                if path.is_symlink():
                    continue
                if any(fnmatch.fnmatchcase(name, pattern) for pattern in spec["pinned"]):
                    add(path, path.suffix in (".db", ".sqlite"))
                elif any(fnmatch.fnmatchcase(name, pattern) for pattern in spec["sessions"]):
                    if spec["companion"] and spec["companion"] in path.relative_to(root).parts:
                        continue
                    info = checked(path)
                    rank = str(path) if spec["order"] == "path_desc" else (info.st_mtime_ns, str(path))
                    candidates.append((rank, path))
        for _, path in sorted(candidates, reverse=True)[:session_cap]:
            add(path)
            if spec["companion"]:
                companion = path.parent / path.stem / spec["companion"]
                if checked(companion, True):
                    try:
                        for directory, dirs, names in os.walk(companion, followlinks=False, onerror=failed_directory_read):
                            dirs[:] = sorted(name for name in dirs if not (Path(directory) / name).is_symlink())
                            for name in sorted(names):
                                child = Path(directory) / name
                                if not child.is_symlink() and any(fnmatch.fnmatchcase(name, pattern) for pattern in spec["sessions"]):
                                    add(child)
                    except OSError:
                        relative = str(Path(spec["relative"]) / companion.relative_to(root))
                        partial.add(relative)
                        unread.add(relative)
        if len(files) > 4096:
            raise ValueError("history export exceeds file limit")

fingerprint = hashlib.sha256(json.dumps([spec, revisions], sort_keys=True).encode()).hexdigest()
if fingerprint == previous and not unread:
    if source_db:
        source_db.close()
    sys.stdout.buffer.write(b"U\n" + fingerprint.encode() + b"\n")
    sys.exit(0)

# Only this private temporary directory is written. Source databases remain read-only.
with tempfile.TemporaryDirectory(prefix="cliora-history-export-") as temporary:
    exports = []
    budget = archive_cap
    for number, (relative, (path, database, size)) in enumerate(files.items()):
        exported = path
        if database:
            exported = Path(temporary) / (str(number) + ".db")
            if source_db is not None and path == root / spec["sqlite"]["index"]:
                snapshot_db(source_db, exported, selection, ids)
            else:
                try:
                    connection = open_db(path)
                    try:
                        if spec.get("sqlite"):
                            snapshot_db(connection, exported)
                        else:
                            catalog_ids, catalog_tables = selected_tables(connection, spec["catalogs"])
                            snapshot_db(connection, exported, catalog_tables, catalog_ids)
                    finally:
                        connection.close()
                except (OSError, ValueError, sqlite3.Error):
                    # Optional title/usage material never hides readable transcripts.
                    partial.add(relative)
                    unread.add(relative)
                    continue
            size = exported.stat().st_size
        if size > file_cap:
            if path.suffix != ".jsonl":
                raise ValueError("history catalog exceeds byte limit")
            # Preserve initial identity plus recent complete rows, with an explicit partial marker.
            exported = Path(temporary) / (str(number) + ".jsonl")
            with path.open("rb") as original, exported.open("wb") as target:
                head = original.read(256 * 1024)
                head = head[:head.rfind(b"\n") + 1]
                target.write(head)
                original.seek(max(len(head), size - (file_cap - len(head))))
                original.readline()
                remaining = size - original.tell()
                while remaining > 0:
                    chunk = original.read(min(65536, remaining))
                    if not chunk:
                        raise ValueError("history source changed during export")
                    target.write(chunk)
                    remaining -= len(chunk)
            size = exported.stat().st_size
            partial.add(relative)
        if size > budget:
            partial.add(relative)
            continue
        budget -= size
        exports.append((relative, exported, size))
    if source_db:
        source_db.close()
    metadata = {"fingerprint": fingerprint, "partial": sorted(partial), "unread": sorted(unread)}
    sys.stdout.buffer.write(b"V\n" + json.dumps(metadata).encode() + b"\n")
    with gzip.GzipFile(fileobj=sys.stdout.buffer, mode="wb", compresslevel=1, mtime=0) as stream:
        for relative, path, size in exports:
            stream.write(("F\n" + relative + "\n" + str(size) + "\n").encode())
            with path.open("rb") as source:
                remaining = size
                while remaining:
                    chunk = source.read(min(65536, remaining))
                    if not chunk:
                        raise ValueError("history source changed during export")
                    stream.write(chunk)
                    remaining -= len(chunk)
        stream.write(b"Z\n")
