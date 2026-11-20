"""Run the installed helper's selection binding against two disposable loopback sshd servers."""
import contextlib
import hashlib
import json
import os
import pathlib
import pwd
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time

Path = pathlib.Path


def run_fixture(binary, directory, processes):
    sshd = shutil.which("sshd") or "/usr/sbin/sshd"
    ssh = shutil.which("ssh")
    username = pwd.getpwuid(os.getuid()).pw_name
    client = directory / "client key"
    known = directory / "known-hosts"
    source = directory / "alias.conf"
    include = directory / "host.conf"
    config = directory / "cliora.db"
    subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", client], check=True)
    source.write_text("Include " + str(include) + "\n")
    with socket.socket() as pick:
        pick.bind(("127.0.0.1", 0))
        port = pick.getsockname()[1]
    for host, family, label in [("127.0.0.1", socket.AF_INET, "A"), ("::1", socket.AF_INET6, "B")]:
        key = directory / ("server-" + label)
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", key], check=True)
        with known.open("a") as fp:
            fp.write("peer-" + label + " " + Path(str(key) + ".pub").read_text())
        cfg = directory / ("sshd-" + label)
        cfg.write_text(f"""ListenAddress {host}
Port {port}
HostKey {key}
PidFile {directory}/{label}.pid
AuthorizedKeysFile "{client}.pub"
StrictModes no
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
PermitUserEnvironment no
AllowUsers {username}
AllowTcpForwarding local
PermitOpen 127.0.0.1:{port}
ForceCommand echo {label}
""")
        log = directory / ("sshd-" + label + ".log")
        proc = subprocess.Popen([sshd, "-D", "-e", "-f", cfg], stderr=log.open("wb"))
        processes.callback(lambda child=proc: child.wait(timeout=5))
        processes.callback(proc.terminate)
        for _ in range(100):
            if proc.poll() is not None:
                raise RuntimeError(log.read_text(errors="replace")[-300:])
            with socket.socket(family) as sock:
                sock.settimeout(0.2)
                if not sock.connect_ex((host, port)):
                    break
            time.sleep(0.04)
        else:
            raise TimeoutError("isolated sshd did not start")

    def settings(host, label):
        return f"Host picked\n HostName {host}\n HostKeyAlias peer-{label}\n UserKnownHostsFile {known}\n GlobalKnownHostsFile none\n"

    profile_a = settings("127.0.0.1", "A")
    profile_b = settings("::1", "B")
    include.write_text(profile_a)
    with sqlite3.connect(config) as db:
        db.executescript("CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE remote_targets(id,name,host,port,user_name,auth_method,identity_file,ssh_config,default_path,enabled,created_at,updated_at);")
        db.execute("INSERT INTO app_settings VALUES(?,?)", ("preferences", json.dumps({"managed_tools": [], "theme": "light", "schema_version": 1, "remote_ssh_enabled": True})))
        db.execute("INSERT INTO remote_targets VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", ("fixture", "Bound alias", "picked", port, username, "key", str(client), str(source), None, 1, 1, 1))
    wrapper = directory / "ssh"
    wrapper.write_text("#!/bin/sh\nif [ \"$1\" != -G ] && [ -f \"$TEST_RACE_INPUT\" ]; then mv \"$TEST_RACE_INPUT\" \"$TEST_INCLUDE\"; fi\nexec \"$TEST_REAL_SSH\" \"$@\"\n")
    wrapper.chmod(0o700)
    race = directory / "race"
    env = {**os.environ, "CLIORA_TWIGLANE_TEST_DB": str(config), "CLIORA_SSH_PROXY": "off",
           "PATH": str(directory) + os.pathsep + os.environ["PATH"], "TEST_REAL_SSH": ssh,
           "TEST_RACE_INPUT": str(race), "TEST_INCLUDE": str(include)}

    def bridge(*args):
        return subprocess.run([binary, "--twiglane-remote-v1", *args], env=env,
                              capture_output=True, text=True, timeout=15)

    def revision():
        reply = bridge("list")
        assert reply.returncode == 0, reply.stderr
        return json.loads(reply.stdout)["targets"][0]["targetRevision"]

    rev_a = revision()
    first = bridge("probe", "fixture", rev_a)
    assert first.returncode == 0 and first.stdout.strip() == "A", first.stderr
    race.write_text(profile_b)
    pinned = bridge("probe", "fixture", rev_a)
    assert pinned.returncode == 0 and pinned.stdout.strip() == "A", pinned.stderr
    assert include.read_text() == profile_b
    stale = bridge("probe", "fixture", rev_a)
    assert stale.returncode == 2 and json.loads(stale.stderr)["error"] == "target_changed"
    checkout_agent = Path(__file__).resolve().parents[2] / "Twiglane/remote-agent/agent"
    digest = hashlib.sha256(checkout_agent.read_bytes()).hexdigest()
    stale_install = bridge("install", "fixture", rev_a, digest, "development")
    assert stale_install.returncode == 2 and json.loads(stale_install.stderr)["error"] == "target_changed"
    rev_b = revision()
    assert rev_a != rev_b
    fresh = bridge("probe", "fixture", rev_b)
    assert fresh.returncode == 0 and fresh.stdout.strip() == "B", fresh.stderr
    jump = (
        "Host jump-b\n  HostName ::1\n  Port " + str(port) + "\n  HostKeyAlias peer-B\n"
        '  IdentityFile "' + str(client) + '"\n  IdentitiesOnly yes\n  UserKnownHostsFile ' + str(known)
        + "\n  GlobalKnownHostsFile none\n  StrictHostKeyChecking yes\n"
    )
    include.write_text(profile_a + "  ProxyJump jump-b\n" + jump)
    rev_jump = revision()
    relay = bridge("probe", "fixture", rev_jump)
    assert relay.returncode == 0 and relay.stdout.strip() == "A", relay.stderr
    include.write_text(profile_a + "  ProxyJump jump-b\n" + jump.replace("peer-B", "different-key"))
    assert json.loads(bridge("probe", "fixture", rev_jump).stderr)["error"] == "target_changed"
    print("Two isolated SSH identities verified: A stayed pinned during the configuration race; stale probe and install were rejected; fresh B connected; B-to-A ProxyJump and jump trust revision were verified.")


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="cliora-ssh-fixture-") as folder, contextlib.ExitStack() as processes:
        run_fixture(os.path.abspath(sys.argv[1]), Path(folder), processes)
