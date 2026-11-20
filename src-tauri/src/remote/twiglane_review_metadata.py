# Fixed operations for a Cliora session. No user-provided Git options or shell commands.
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import socket
import subprocess
import sys
import tempfile

ENV = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
ENV.update(GIT_OPTIONAL_LOCKS="0", GIT_TERMINAL_PROMPT="0", LC_ALL="C")


def git_args(root, *args):
    return ["git", "--no-optional-locks", "-c", "core.fsmonitor=false", "-C", str(root), *args]


def git(root, *args, optional=False):
    proc = subprocess.run(git_args(root, *args), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL, env=ENV, timeout=45)
    if proc.returncode:
        if optional: return None
        raise ValueError("not_a_worktree")
    return os.fsdecode(proc.stdout[:-1] if proc.stdout.endswith(b"\n") else proc.stdout)


def location(path):
    if not Path(path).is_absolute(): raise ValueError("invalid_path")
    root = Path(git(path, "rev-parse", "--show-toplevel")).resolve(strict=True)
    git_dir = Path(git(root, "rev-parse", "--absolute-git-dir")).resolve(strict=True)
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
    if store.exists():
        info = store.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
            raise ValueError("unsafe_record")
    return store / hashlib.sha256(session.encode()).hexdigest()


def head(root):
    oid = git(root, "rev-parse", "--verify", "HEAD^{commit}", optional=True)
    return oid if oid and re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", oid) else None


def remember(session):
    root, key, _ = location(os.getcwd())
    dest = record_file(session, True)
    # A reattachment or duplicate startup must never replace the original baseline.
    with tempfile.NamedTemporaryFile(mode="w", dir=dest.parent, delete=False) as tmp:
        try:
            json.dump({"root": str(root), "key": key, "baseline": head(root)}, tmp)
            tmp.flush()
            os.link(tmp.name, dest)
        finally:
            os.unlink(tmp.name)


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
        fd = os.open(dest, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        try:
            root, key, worktree_identity = location(path)
        except (OSError, ValueError, subprocess.SubprocessError):
            raise ValueError("remote_review_restart") from None
        pane = legacy_pane(session, key)
    else:
        with os.fdopen(fd, "rb") as f:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022 or info.st_size > 8192: raise ValueError("unsafe_record")
            saved = json.load(f)
        root, key, worktree_identity = location(path)
        if saved["key"] != key or saved["root"] != str(root): raise ValueError("worktree_changed")
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
    return {"root": str(root), "key": key, "worktreeIdentity": worktree_identity, "headOid": before, "branch": branch, "uncommitted": count, "baseline": baseline}


if __name__ == "__main__":
    try:
        if sys.argv[1] == "record":
            remember(sys.argv[2])
        elif sys.argv[1] == "inspect":
            print("cliora-review/1", flush=True)
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
        sys.exit(2)
