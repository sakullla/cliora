#!/usr/bin/env bash
# Install the Ubuntu packages the Tauri build needs on GitHub-hosted runners.
#
# The runners' default Ubuntu mirrors fail in two ways: azure.archive.ubuntu.com
# hangs after its Ign:/Get: fallback (actions/runner-images#11347, #12949, #14594),
# and at times neither it nor archive.ubuntu.com resolves at all while every other
# host does. So this script probes several mirrors, writes the first one that
# answers as the only apt source (main and security suites alike), and installs
# from it, moving on to the next mirror when one stops answering midway.
# `timeout` guards every apt call because apt's own Acquire::Timeout is unreliable.
#
#   install-linux-deps.sh                   configure a mirror, then install PACKAGES
#   install-linux-deps.sh --configure-only  configure a working mirror and refresh the
#                                           index, for tools that run apt themselves
#                                           (e.g. `playwright install --with-deps`)
#
# CLIORA_APT_MIRRORS (space separated) replaces the candidate list.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

CONFIGURE_ONLY=0
if [ "${1:-}" = "--configure-only" ]; then CONFIGURE_ONLY=1; fi

# shellcheck disable=SC1091
. /etc/os-release
CODENAME="${UBUNTU_CODENAME:-${VERSION_CODENAME:-jammy}}"

if [ -n "${CLIORA_APT_MIRRORS:-}" ]; then
  read -r -a MIRRORS <<<"${CLIORA_APT_MIRRORS}"
else
  MIRRORS=(
    http://archive.ubuntu.com/ubuntu
    http://azure.archive.ubuntu.com/ubuntu
    http://us.archive.ubuntu.com/ubuntu
    http://mirrors.edge.kernel.org/ubuntu
    http://mirrors.mit.edu/ubuntu
    http://mirror.math.princeton.edu/pub/ubuntu
  )
fi

PACKAGES=(
  libwebkit2gtk-4.1-dev
  libgtk-3-dev
  libayatana-appindicator3-dev
  librsvg2-dev
  patchelf
)

sudo tee /etc/apt/apt.conf.d/99-gha-acquire >/dev/null <<'EOF'
Acquire::Retries "1";
Acquire::http::Timeout "15";
Acquire::https::Timeout "15";
Acquire::ftp::Timeout "15";
Acquire::ForceIPv4 "true";
Dpkg::Use-Pty "0";
EOF

APT_OPTS=(
  -o Acquire::Retries=1
  -o Acquire::http::Timeout=15
  -o Acquire::https::Timeout=15
  -o Acquire::ftp::Timeout=15
  -o Acquire::ForceIPv4=true
  -o Dpkg::Use-Pty=0
)

# 124 = timeout(1) sent SIGTERM.
run_apt() {
  local seconds="$1"
  shift
  sudo timeout --signal=TERM --kill-after=15s "${seconds}" \
    apt-get "${APT_OPTS[@]}" "$@"
}

# A mirror counts only when its release file for this codename is actually served.
reachable() {
  curl -fsS --ipv4 --connect-timeout 5 --max-time 15 -o /dev/null \
    "$1/dists/${CODENAME}/InRelease"
}

# Make the mirror the only apt source. Image extras (Azure CLI, Microsoft, Chrome,
# PPAs) are unused here and stall `apt-get update` on the same runners, so every
# other source list is moved aside rather than edited.
use_mirror() {
  local mirror="$1"
  shopt -s nullglob
  local extras=(/etc/apt/sources.list.d/*)
  shopt -u nullglob
  if [ "${#extras[@]}" -gt 0 ]; then
    sudo mkdir -p /etc/apt/sources.list.d.disabled
    sudo mv -f "${extras[@]}" /etc/apt/sources.list.d.disabled/
  fi
  sudo rm -f /etc/apt/apt-mirrors.txt
  sudo tee /etc/apt/sources.list >/dev/null <<EOF
deb ${mirror} ${CODENAME} main restricted universe multiverse
deb ${mirror} ${CODENAME}-updates main restricted universe multiverse
deb ${mirror} ${CODENAME}-backports main restricted universe multiverse
deb ${mirror} ${CODENAME}-security main restricted universe multiverse
EOF
}

for pass in 1 2; do
  for mirror in "${MIRRORS[@]}"; do
    if ! reachable "${mirror}"; then
      echo "apt mirror unreachable: ${mirror}" >&2
      continue
    fi
    echo "Using apt mirror ${mirror} (pass ${pass})"
    use_mirror "${mirror}"
    if ! run_apt 120 update; then
      echo "apt-get update failed on ${mirror}" >&2
      continue
    fi
    if [ "${CONFIGURE_ONLY}" = 1 ]; then exit 0; fi
    if run_apt 240 install -y --no-install-recommends "${PACKAGES[@]}"; then exit 0; fi
    echo "apt-get install failed on ${mirror}" >&2
  done
  sleep $((pass * 10))
done

echo "No apt mirror could install the dependencies: ${MIRRORS[*]}" >&2
exit 1
