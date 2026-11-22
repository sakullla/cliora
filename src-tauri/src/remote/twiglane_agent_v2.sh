set -eu
export LC_ALL=C

fail() {
    printf '{"error":"%s"}\n' "$1" >&2
    exit 2
}

# Wait for the desktop's independent host-key verification before using stdin.
if [ "$op" != probe ]; then
    printf 'twiglane-peer/1\n'
    [ "$(dd bs=1 count=1 2>/dev/null)" = G ] || fail peer_unverified
fi

uid=$(id -u)
check_private() {
    [ ! -L "$1" ] || fail unsafe_install_directory
    metadata=$(ls -ldn "$1" 2>/dev/null) || fail unsafe_install_directory
    mode=$(printf '%s' "$metadata" | cut -c1-10)
    owner=$(printf '%s' "$metadata" | awk '{print $3}')
    [ "$owner" = "$uid" ] || fail unsafe_install_directory
    case "$mode" in ?????w*|????????w*) fail unsafe_install_directory ;; esac
}

directory="$HOME"
for part in .local share twiglane agent v2; do
    directory="$directory/$part"
    if [ ! -e "$directory" ] && [ ! -L "$directory" ]; then
        case "$op" in
            probe) break ;;
            install) (umask 077; mkdir "$directory") || fail unsafe_install_directory ;;
            connect) fail agent_missing ;;
        esac
    fi
    [ -d "$directory" ] || fail unsafe_install_directory
    check_private "$directory"
done
directory="$HOME/.local/share/twiglane/agent/v2"
agent="$directory/twiglane-agent-v2"

digest_file() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | cut -d ' ' -f1
    else
        shasum -a 256 "$1" | cut -d ' ' -f1
    fi
}

case "$op" in
    probe)
        printf 'system=%s\narchitecture=%s\n' "$(uname -s)" "$(uname -m)"
        if git --version >/dev/null 2>&1; then printf 'git=%s\n' "$(git --version)"; fi
        if [ -e "$directory" ] || [ -L "$directory" ]; then
            check_private "$directory"
            if [ -f "$agent" ] || [ -L "$agent" ]; then
                check_private "$agent"
                printf 'digest=%s\n' "$(digest_file "$agent")"
            fi
        fi
        ;;
    install)
        umask 077
        check_private "$directory"
        temporary=$(mktemp "$directory/.incoming.XXXXXXXX")
        trap 'rm -f "$temporary"' 0
        cat > "$temporary"
        [ "$(digest_file "$temporary")" = "$digest" ] || fail agent_digest_mismatch
        chmod 700 "$temporary"
        mv -f "$temporary" "$agent"
        printf '{"installed":true,"agentSha256":"%s"}\n' "$digest"
        ;;
    connect)
        [ -d "$directory" ] && [ -f "$agent" ] || fail agent_missing
        check_private "$directory"
        check_private "$agent"
        umask 077
        hold=$(mktemp -d "$directory/.active.XXXXXXXX")
        trap 'rm -f "$hold/agent"; rmdir "$hold"' 0
        ln "$agent" "$hold/agent"
        [ "$(digest_file "$hold/agent")" = "$digest" ] || fail agent_digest_mismatch
        "$hold/agent" --stdio
        ;;
esac
