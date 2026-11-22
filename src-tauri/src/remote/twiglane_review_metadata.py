# Fixed operations for a Cliora session. No user-provided Git options or shell commands.
import hashlib
import base64
import json
import os
from pathlib import Path
import re
import shutil
import stat
import socket
import subprocess
import sys
import tempfile

ENV = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
ENV.update(GIT_OPTIONAL_LOCKS="0", GIT_TERMINAL_PROMPT="0", LC_ALL="C")
WINDOWS = os.name == "nt"


def canonical_path(path):
    if not WINDOWS:
        return str(path)
    value = path.as_posix()
    if value.startswith("//?/"):
        value = value[4:]
    if not re.match(r"^[A-Za-z]:/", value):
        raise ValueError("invalid_path")
    return value[0].upper() + value[1:]


def windows_hostname():
    import ctypes
    from ctypes import wintypes

    size = wintypes.DWORD(256)
    value = ctypes.create_unicode_buffer(size.value)
    if not ctypes.windll.kernel32.GetComputerNameExW(5, value, ctypes.byref(size)):
        raise ctypes.WinError()
    return value.value.lower()


def windows_identity(path):
    import ctypes
    from ctypes import wintypes

    class FileInfo(ctypes.Structure):
        _fields_ = [("attributes", wintypes.DWORD), ("created", wintypes.FILETIME),
                    ("accessed", wintypes.FILETIME), ("modified", wintypes.FILETIME),
                    ("volume", wintypes.DWORD), ("size_high", wintypes.DWORD),
                    ("size_low", wintypes.DWORD), ("links", wintypes.DWORD),
                    ("index_high", wintypes.DWORD), ("index_low", wintypes.DWORD)]

    kernel = ctypes.windll.kernel32
    create = kernel.CreateFileW
    create.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
                       wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    create.restype = wintypes.HANDLE
    get_info = kernel.GetFileInformationByHandle
    get_info.argtypes = [wintypes.HANDLE, ctypes.POINTER(FileInfo)]
    close = kernel.CloseHandle
    close.argtypes = [wintypes.HANDLE]
    handle = create(str(path), 0, 7, None, 3, 0x02000000, None)
    if handle == ctypes.c_void_p(-1).value:
        raise ctypes.WinError()
    try:
        info = FileInfo()
        if not get_info(handle, ctypes.byref(info)):
            raise ctypes.WinError()
        return [canonical_path(path), info.volume, (info.index_high << 32) | info.index_low]
    finally:
        close(handle)


def git_args(root, *args):
    return ["git", "--no-optional-locks", "-c", "core.fsmonitor=false", "-C", str(root), *args]


def git(root, *args, optional=False):
    proc = subprocess.run(git_args(root, *args), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL, env=ENV, timeout=45)
    if proc.returncode:
        if optional: return None
        raise ValueError("not_a_worktree")
    data = proc.stdout[:-1] if proc.stdout.endswith(b"\n") else proc.stdout
    if WINDOWS:
        return (data[:-1] if data.endswith(b"\r") else data).decode("utf-8")
    return os.fsdecode(data)


def location(path):
    if not Path(path).is_absolute(): raise ValueError("invalid_path")
    root = Path(git(path, "rev-parse", "--show-toplevel")).resolve(strict=True)
    git_dir = Path(git(root, "rev-parse", "--absolute-git-dir")).resolve(strict=True)
    if WINDOWS:
        hostname = windows_hostname()
        roots = [windows_identity(root), windows_identity(git_dir)]
        wire = json.dumps([hostname, *roots], ensure_ascii=True, separators=(",", ":")).encode()
        digest = hashlib.sha256(wire).hexdigest()
        return root, digest, digest

    def identity(p):
        s = p.stat()
        return [str(p), s.st_dev, s.st_ino]
    machine = socket.gethostname()
    for source in ("/etc/machine-id", "/var/lib/dbus/machine-id"):
        try:
            machine = Path(source).read_text().strip() or machine
            break
        except OSError:
            pass
    key = hashlib.sha256(json.dumps([machine, os.geteuid(), identity(root), identity(git_dir)]).encode()).hexdigest()
    wire = json.dumps([socket.gethostname(), identity(root), identity(git_dir)], ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode()
    return root, key, hashlib.sha256(wire).hexdigest()


def record_file(session, create=False):
    if not re.fullmatch(r"cliora-[A-Za-z0-9_-]{1,194}", session): raise ValueError("unknown_session")
    store = Path.home() / ".local/state/cliora/session-review"
    if create: store.mkdir(mode=0o700, parents=True, exist_ok=True)
    if store.exists() or store.is_symlink():
        info = store.lstat()
        if not stat.S_ISDIR(info.st_mode) or not private_entry(info):
            raise ValueError("unsafe_record")
    return store / hashlib.sha256(session.encode()).hexdigest()


def head(root):
    oid = git(root, "rev-parse", "--verify", "HEAD^{commit}", optional=True)
    return oid if oid and re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", oid) else None


def remember(session):
    root, key, _ = location(os.getcwd())
    dest = record_file(session, True)
    # A reattachment or duplicate startup must never replace the original baseline.
    data = {"root": canonical_path(root), "key": key, "baseline": head(root)}
    with tempfile.NamedTemporaryFile(mode="w", dir=dest.parent, delete=False) as tmp:
        temp_path = tmp.name
        try:
            json.dump(data, tmp)
            tmp.close()
            os.link(temp_path, dest)
        finally:
            tmp.close()
            os.unlink(temp_path)


def private_entry(info):
    if WINDOWS:
        return not info.st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT
    return info.st_uid == os.geteuid() and not info.st_mode & 0o022


def open_record(path):
    if not WINDOWS:
        return os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode) or not private_entry(before):
        raise ValueError("unsafe_record")
    fd = os.open(path, os.O_RDONLY | os.O_BINARY)
    try:
        after = os.fstat(fd)
        current = path.lstat()
        if not private_entry(current) or not os.path.samestat(before, current) or not os.path.samestat(before, after):
            raise ValueError("unsafe_record")
        return fd
    except BaseException:
        os.close(fd)
        raise


def legacy_pane(session, expected_key):
    # An older launch has no checkout receipt. A session name alone is insufficient:
    # read all windows of the exact tmux session and require one live pane.
    fields = "#{session_name}\t#{pane_id}\t#{pane_pid}\t#{pane_dead}\t#{pane_current_path}"
    try:
        result = subprocess.run(["tmux", "list-panes", "-s", "-t", "=" + session + ":", "-F", fields],
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, timeout=10, check=True)
        line, = result.stdout.decode().splitlines()
        name, pane, pid, dead, cwd = line.split("\t")
        if name != session or dead != "0" or not re.fullmatch(r"%[0-9]+", pane) or not re.fullmatch(r"[1-9][0-9]*", pid):
            raise ValueError("invalid_pane")
        if not os.path.isabs(cwd) or any(ord(c) < 32 for c in cwd) or location(cwd)[1] != expected_key:
            raise ValueError("different_checkout")
        if sys.platform.startswith("linux"):
            # Keep the live kernel cwd attached to the same checkout. A stale textual
            # path can already name a replacement directory after a move or unlink.
            if location(f"/proc/{pid}/cwd")[1] != expected_key:
                raise ValueError("different_checkout")
    except (OSError, ValueError, subprocess.SubprocessError):
        # screen does not provide a portable, independently verifiable pane cwd.
        raise ValueError("remote_review_restart") from None
    return pane, pid


def usable_baseline(root, baseline, current):
    if not baseline or not current or not isinstance(baseline, str) or not re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", baseline):
        return None
    if baseline == current or git(root, "merge-base", "--is-ancestor", baseline, current, optional=True) is not None:
        return baseline
    return None


def read(session, path):
    dest = record_file(session)
    baseline = None
    pane = None
    try:
        fd = open_record(dest)
    except FileNotFoundError:
        if WINDOWS:
            raise ValueError("remote_review_restart") from None
        try:
            root, key, worktree_identity = location(path)
        except (OSError, ValueError, subprocess.SubprocessError):
            raise ValueError("remote_review_restart") from None
        pane = legacy_pane(session, key)
    else:
        with os.fdopen(fd, "rb") as f:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or not private_entry(info) or info.st_size > 8192: raise ValueError("unsafe_record")
            saved = json.load(f)
        root, key, worktree_identity = location(path)
        if saved["key"] != key or saved["root"] != canonical_path(root): raise ValueError("worktree_changed")
        baseline = saved["baseline"]
    before = head(root)
    baseline = usable_baseline(root, baseline, before)
    branch = git(root, "symbolic-ref", "-q", "--short", "HEAD", optional=True)
    count = 0
    with subprocess.Popen(git_args(root, "status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=none"),
                          stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=ENV) as proc:
        pending = b""
        skip_original = False
        while True:
            chunk = proc.stdout.read(65536)
            if not chunk: break
            entries = (pending + chunk).split(b"\x00")
            pending = entries.pop()
            for entry in entries:
                if skip_original:
                    skip_original = False
                else:
                    count += 1
                    skip_original = entry.startswith(b"2 ")
        if pending or skip_original or proc.wait() != 0: raise ValueError("read_failed")
    if pane is not None and legacy_pane(session, key) != pane: raise ValueError("remote_review_restart")
    if before != head(root) or location(path)[1] != key: raise ValueError("worktree_changed")
    return {"root": canonical_path(root), "key": key, "worktreeIdentity": worktree_identity, "headOid": before, "branch": branch, "uncommitted": count, "baseline": baseline}


def launch_windows(encoded):
    if not WINDOWS:
        raise ValueError("unsupported_action")
    request = json.loads(base64.b64decode(encoded, validate=True).decode("utf-8"))
    session = request["session"]
    record_file(session)
    executable = request["executable"]
    if not re.fullmatch(r"[A-Za-z0-9_-]+(?:\.exe)?", executable, re.IGNORECASE):
        raise ValueError("invalid_cli")
    native = executable if executable.lower().endswith(".exe") else executable + ".exe"
    application = shutil.which(native)
    if not application:
        raise ValueError("Cliora: remote CLI executable is unavailable on PATH")
    os.chdir(request["directory"])
    try:
        remember(session)
    except ValueError as error:
        if str(error) != "not_a_worktree":
            raise
    # The workbench sees the same ready and ended markers as it does from tmux.
    print(f"\x1b]777;cliora;{session};ready\x07", end="", flush=True)
    try:
        environment = {**os.environ, **dict(request["environment"]), "TERM": "xterm-256color", "COLORTERM": "truecolor"}
        return subprocess.call([application, *request["args"]], env=environment)
    finally:
        print(f"\x1b]777;cliora;{session};ended\x07", end="", flush=True)


if __name__ == "__main__":
    try:
        if sys.argv[1] == "record":
            remember(sys.argv[2])
        elif sys.argv[1] == "launch":
            sys.exit(launch_windows(sys.argv[2]))
        elif sys.argv[1] == "inspect":
            sys.stdout.buffer.write(b"cliora-review/1\n")
            sys.stdout.buffer.flush()
            req = json.loads(sys.stdin.buffer.readline(16384))
            print(json.dumps(read(req["session"], req["directory"])), flush=True)
        else:
            raise ValueError("unsupported_action")
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        if sys.argv[1] == "inspect":
            reason = str(error)
            if reason not in ("remote_review_restart", "worktree_changed", "not_a_worktree"):
                reason = "read_failed"
            print(json.dumps({"error": reason}), flush=True)
        elif sys.argv[1] == "launch":
            print("Cliora: could not start the Windows SSH session. Check the project path, Git, and the native CLI on PATH.", file=sys.stderr)
        sys.exit(2)
