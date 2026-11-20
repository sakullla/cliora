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
    support = directory / "Application Support"
    support.mkdir()
    known = support / "known hosts"
    extra = support / "secondary trust"
    extra.touch()
    source = directory / "alias.conf"
    include = directory / "host.conf"
    config = directory / "cliora.db"
    subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", client], check=True)
    source.write_text("Include " + str(include) + "\n")
    with socket.socket() as pick:
        pick.bind(("127.0.0.1", 0))
        port = pick.getsockname()[1]
    servers = {}
    for host, family, label in [("127.0.0.1", socket.AF_INET, "A"), ("::1", socket.AF_INET6, "B")]:
        key = directory / ("server-" + label)
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", key], check=True)
        with known.open("a") as fp:
            fp.write("peer-" + label + " " + Path(str(key) + ".pub").read_text())
        forced = directory / ("force-" + label)
        bootstrap = Path(__file__).resolve().parents[1] / "src-tauri/src/remote/twiglane_agent_setup.py"
        forced.write_text("#!/usr/bin/env python3\nimport os,sys,json,shlex\n"
                          + f"if os.path.isfile({str(directory / 'use-bootstrap')!r}):\n"
                          + " args=shlex.split(os.environ['SSH_ORIGINAL_COMMAND'])[5:]\n"
                          + " if not args or args[0] not in ('probe','install','connect'): sys.exit(2)\n"
                          + f" os.environ['HOME']={str(directory / 'remote-home')!r}\n"
                          + f" os.execv(sys.executable,[sys.executable,'-I',{str(bootstrap)!r},*args])\n"
                          + "if not os.environ['SSH_ORIGINAL_COMMAND'].endswith(' probe'):\n"
                          + " sys.stdout.buffer.write(b'twiglane-peer/1\\n'); sys.stdout.buffer.flush()\n"
                          + " if sys.stdin.buffer.read(1) != b'G': sys.exit(2)\n"
                          + f"print(json.dumps({{'label': {label!r}}}))\n")
        forced.chmod(0o700)
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
ForceCommand {forced}
""")
        log = directory / ("sshd-" + label + ".log")
        proc = subprocess.Popen([sshd, "-D", "-e", "-f", cfg], stderr=log.open("wb"))
        servers[label] = proc
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
        return f"Host picked\n HostName {host}\n HostKeyAlias peer-{label}\n UserKnownHostsFile \"{known}\"\n GlobalKnownHostsFile none\n"

    profile_a = settings("127.0.0.1", "A")
    profile_b = settings("::1", "B")
    include.write_text(profile_a)
    with sqlite3.connect(config) as db:
        db.executescript("CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE remote_targets(id,name,host,port,user_name,auth_method,identity_file,ssh_config,default_path,enabled,created_at,updated_at);")
        db.execute("INSERT INTO app_settings VALUES(?,?)", ("preferences", json.dumps({"managed_tools": [], "theme": "light", "schema_version": 1, "remote_ssh_enabled": True})))
        db.execute("INSERT INTO remote_targets VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", ("fixture", "Bound alias", "picked", port, username, "key", str(client), str(source), None, 1, 1, 1))
    wrapper = directory / "ssh"
    wrapper.write_text("#!/bin/sh\nif [ \"$1\" != -G ] && [ -f \"$TEST_RACE_INPUT\" ]; then mv \"$TEST_RACE_INPUT\" \"$TEST_INCLUDE\"; fi\nif [ \"$1\" != -G ] && [ -f \"$TEST_TRUST_RACE\" ]; then mv \"$TEST_TRUST_RACE\" \"$TEST_KNOWN\"; fi\nif [ \"$1\" != -G ] && [ -n \"$TEST_SKIP_OBSERVATION\" ]; then printf 'twiglane-peer/1\\n'; if [ -n \"$(dd bs=1 count=1 2>/dev/null)\" ]; then touch \"$TEST_UNVERIFIED_INPUT\"; fi; exit 0; fi\nexec \"$TEST_REAL_SSH\" \"$@\"\n")
    wrapper.chmod(0o700)
    race = directory / "race"
    env = {**os.environ, "CLIORA_TWIGLANE_TEST_DB": str(config), "CLIORA_SSH_PROXY": "off",
           "PATH": str(directory) + os.pathsep + os.environ["PATH"], "TEST_REAL_SSH": ssh,
           "TEST_RACE_INPUT": str(race), "TEST_INCLUDE": str(include), "TEST_TRUST_RACE":str(directory / "trust-race"), "TEST_KNOWN":str(known)}

    def bridge(*args, payload=""):
        return subprocess.run([binary, "--twiglane-remote-v1", *args], env=env,
                              capture_output=True, text=True, input=payload, timeout=15)

    def revision():
        reply = bridge("list")
        assert reply.returncode == 0, reply.stderr
        return json.loads(reply.stdout)["targets"][0]["targetRevision"]

    rev_a = revision()
    first = bridge("probe", "fixture", rev_a)
    assert first.returncode == 0 and json.loads(first.stdout)["label"] == "A", first.stderr
    trust_before = known.read_bytes()
    (directory / "trust-race").write_text("# replaced between trust snapshot and SSH\n")
    frozen = bridge("probe", "fixture", rev_a)
    assert frozen.returncode == 0 and json.loads(frozen.stdout)["peerRevision"] == json.loads(first.stdout)["peerRevision"], frozen.stderr
    assert known.read_bytes() != trust_before and revision() != rev_a
    known.write_bytes(trust_before)
    race.write_text(profile_b)
    pinned = bridge("probe", "fixture", rev_a)
    assert pinned.returncode == 0 and json.loads(pinned.stdout)["label"] == "A", pinned.stderr
    assert include.read_text() == profile_b
    stale = bridge("probe", "fixture", rev_a)
    assert stale.returncode == 2 and json.loads(stale.stderr)["error"] == "target_changed"
    checkout_agent = Path(__file__).resolve().parents[2] / "Twiglane/remote-agent/agent"
    digest = hashlib.sha256(checkout_agent.read_bytes()).hexdigest()
    stale_install = bridge("install", "fixture", json.loads(first.stdout)["peerRevision"], digest, "development")
    assert stale_install.returncode == 2 and json.loads(stale_install.stderr.splitlines()[-1])["error"] == "target_changed"
    rev_b = revision()
    assert rev_a != rev_b
    fresh = bridge("probe", "fixture", rev_b)
    assert fresh.returncode == 0 and json.loads(fresh.stdout)["label"] == "B", fresh.stderr
    jump = (
        "Host jump-b\n  HostName ::1\n  Port " + str(port) + "\n  HostKeyAlias peer-B\n"
        '  IdentityFile "' + str(client) + '"\n  IdentitiesOnly yes\n  UserKnownHostsFile "' + str(known)
        + '" "' + str(extra) + '"' + "\n  GlobalKnownHostsFile none\n  StrictHostKeyChecking yes\n"
    )
    include.write_text(profile_a + "  ProxyJump jump-b\n" + jump)
    rev_jump = revision()
    relay = bridge("probe", "fixture", rev_jump)
    assert relay.returncode == 0 and json.loads(relay.stdout)["label"] == "A", relay.stderr
    include.write_text(profile_a + "  ProxyJump jump-b\n" + jump.replace("peer-B", "different-key"))
    assert json.loads(bridge("probe", "fixture", rev_jump).stderr)["error"] == "target_changed"
    # Same address, port, account, alias and paths. Rotate only the sshd host key.
    include.write_text(profile_a.replace(f'"{known}"', f'"{known}" "{extra}"'))
    def checked_probe(rev):
        result = bridge("probe", "fixture", rev)
        assert result.returncode == 0, result.stderr
        return json.loads(result.stdout)
    def rotate(key):
        servers["A"].terminate()
        servers["A"].wait(timeout=5)
        cfg = directory / "sshd-A"
        lines = cfg.read_text().splitlines()
        cfg.write_text("\n".join("HostKey " + str(key) if line.startswith("HostKey ") else line for line in lines) + "\n")
        proc = subprocess.Popen([sshd, "-D", "-e", "-f", cfg], stderr=subprocess.DEVNULL)
        servers["A"] = proc
        processes.callback(lambda: proc.wait(timeout=5))
        processes.callback(proc.terminate)
        for _ in range(100):
            with socket.socket() as ready:
                if not ready.connect_ex(("127.0.0.1", port)): return
            time.sleep(0.04)
        raise RuntimeError("rotated fixture failed to start")
    old_catalog = revision()
    old_peer = checked_probe(old_catalog)["peerRevision"]
    assert len(old_peer) == 64 and checked_probe(old_catalog)["peerRevision"] == old_peer
    replacement = directory / "replacement"
    subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", replacement], check=True)
    replacement_key = "peer-A " + Path(str(replacement) + ".pub").read_text()
    rotate(replacement)
    extra.write_text(replacement_key)
    new_catalog = revision()
    assert old_catalog != new_catalog and bridge("probe", "fixture", old_catalog).returncode == 2
    for action in ("install", "connect"):
        wrong = bridge(action, "fixture", old_peer, digest, "development")
        assert wrong.returncode != 0 and not wrong.stdout, (wrong.stdout, wrong.stderr)
    new_peer = checked_probe(new_catalog)["peerRevision"]
    assert new_peer != old_peer
    assert bridge("connect", "fixture", new_peer, digest, "development").returncode == 0
    env["TEST_SKIP_OBSERVATION"] = "1"
    env["TEST_UNVERIFIED_INPUT"] = str(directory / "unverified-dispatch")
    skipped = bridge("install", "fixture", new_peer, digest, "development")
    assert skipped.returncode == 2 and not (directory / "unverified-dispatch").exists()
    del env["TEST_SKIP_OBSERVATION"]
    # Both keys remain trusted under the same alias. Only the authenticated peer changes.
    rotate(directory / "server-A")
    assert revision() == new_catalog
    wrong = bridge("install", "fixture", new_peer, digest, "development")
    assert wrong.returncode != 0 and not wrong.stdout
    fresh_peer = checked_probe(new_catalog)["peerRevision"]
    assert fresh_peer != new_peer
    assert bridge("connect", "fixture", fresh_peer, digest, "development").returncode == 0
    provider = support / "host key provider"
    provider.write_text("#!/bin/sh\ncat '" + str(known) + "'\n")
    provider.chmod(0o700)
    include.write_text("Host picked\n HostName 127.0.0.1\n HostKeyAlias peer-A\n UserKnownHostsFile none\n GlobalKnownHostsFile none\n KnownHostsCommand \"" + str(provider) + "\" %I %H\n")
    provided_peer = checked_probe(revision())["peerRevision"]
    assert bridge("connect", "fixture", provided_peer, digest, "development").returncode == 0
    (directory / "use-bootstrap").touch()
    live_peer = checked_probe(revision())["peerRevision"]
    install = bridge("install", "fixture", live_peer, digest, "development", payload=checkout_agent.read_text())
    assert install.returncode == 0 and json.loads(install.stdout.splitlines()[-1])["installed"], install.stderr
    after = checked_probe(revision())
    assert after["agentSha256"] == digest and after["peerRevision"] == live_peer
    hello = bridge("connect", "fixture", live_peer, digest, "development", payload='{"v":1,"id":"smoke","op":"hello"}\n')
    assert hello.returncode == 0 and json.loads(hello.stdout)["result"]["protocol"] == 1, hello.stderr
    print("Verified two SSH identities and ProxyJump, include races, quoted single and multiple trust files, rotation at one address, and rejection before dispatch with two trusted host keys.")


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="cliora-ssh-fixture-") as folder, contextlib.ExitStack() as processes:
        run_fixture(os.path.abspath(sys.argv[1]), Path(folder), processes)
