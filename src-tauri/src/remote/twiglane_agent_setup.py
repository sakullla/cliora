# Fixed bootstrap carried in the SSH invocation. stdin belongs to the upload or agent.
import hashlib
import json
import os
import platform
import stat
import sys
import tempfile

LIMIT = 8 * 1024 * 1024
CHUNK = 4096


def emit(value):
    print(json.dumps(value, separators=(",", ":")), flush=True)


def fail(reason):
    print(json.dumps({"error": reason}), file=sys.stderr, flush=True)
    raise SystemExit(2)


def agent_dir(create):
    parent = os.path.join(os.path.expanduser("~"), ".local", "share")
    if create:
        os.makedirs(parent, mode=0o700, exist_ok=True)
    for component in ("twiglane", "agent", "v1"):
        parent = os.path.join(parent, component)
        if create:
            try:
                os.mkdir(parent, 0o700)
            except FileExistsError:
                pass
        try:
            info = os.lstat(parent)
        except FileNotFoundError:
            return None
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
            fail("unsafe_install_directory")
    return parent


def current_agent(directory):
    if directory is None:
        return None
    try:
        fd = os.open(os.path.join(directory, "agent"), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022 or info.st_size > LIMIT:
        os.close(fd)
        fail("unsafe_agent")
    return os.fdopen(fd, "rb")


def saved_signature(directory, digest):
    if digest is None:
        return None
    try:
        fd = os.open(os.path.join(directory, digest + ".sig"), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    with os.fdopen(fd, "rb") as proof:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022 or info.st_size > 4096:
            return None
        try:
            return proof.read(4096).decode("ascii")
        except UnicodeDecodeError:
            return None


def install(directory, expected, signature):
    dest = os.path.join(directory, "agent")
    with tempfile.NamedTemporaryFile(dir=directory, prefix=".incoming-", delete=False) as file:
        name = file.name
        try:
            digest = hashlib.sha256()
            size = 0
            while True:
                chunk = sys.stdin.buffer.read(CHUNK)
                if not chunk:
                    break
                size += len(chunk)
                if size > LIMIT:
                    fail("agent_too_large")
                file.write(chunk)
                digest.update(chunk)
                emit({"receivedBytes": size})
            if digest.hexdigest() != expected:
                fail("agent_digest_mismatch")
            file.flush()
            os.fchmod(file.fileno(), 0o700)
            os.fsync(file.fileno())
            with tempfile.NamedTemporaryFile(dir=directory, prefix=".proof-", delete=False) as proof:
                try:
                    proof.write(signature.encode("ascii"))
                    proof.flush()
                    os.fsync(proof.fileno())
                    os.replace(proof.name, os.path.join(directory, expected + ".sig"))
                finally:
                    try:
                        os.unlink(proof.name)
                    except FileNotFoundError:
                        pass
            os.replace(name, dest)
        finally:
            try:
                os.unlink(name)
            except FileNotFoundError:
                pass
    emit({"installed": True, "agentSha256": expected})


def run():
    op = sys.argv[1]
    directory = agent_dir(op == "install")
    if op == "probe":
        source = current_agent(directory)
        digest = None
        if source is not None:
            with source:
                digest = hashlib.sha256(source.read(LIMIT + 1)).hexdigest()
        emit({"system": platform.system(), "architecture": platform.machine(),
              "pythonVersion": platform.python_version(), "agentSha256": digest, "agentSignature": saved_signature(directory, digest)})
    elif op == "install":
        install(directory, sys.argv[2], sys.argv[3])
    elif op == "connect":
        source = current_agent(directory)
        if source is None:
            fail("agent_digest_mismatch")
        with source:
            program = source.read(LIMIT + 1)
        if hashlib.sha256(program).hexdigest() != sys.argv[2]:
            fail("agent_digest_mismatch")
        # A concurrent install may replace the path. Start precisely the verified bytes.
        path = os.path.join(directory, "agent")
        sys.argv = [path]
        exec(compile(program, path, "exec"), {"__name__": "__main__", "__file__": path})
    else:
        fail("unsupported_action")


try:
    run()
except OSError:
    fail("agent_io")
