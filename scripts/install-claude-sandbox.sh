#!/usr/bin/env bash
# Ubuntu/Debian: install TARS-only sandbox helpers without sudo or system package changes.
set -euo pipefail
tars_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
tars_packages=$(mktemp -d)
trap 'rm -rf -- "$tars_packages"' EXIT
cd -- "$tars_packages"
apt-get download bubblewrap socat
mkdir -p -- "$tars_root/.tars-run/sandbox"
for package in ./*.deb; do dpkg-deb -x "$package" "$tars_root/.tars-run/sandbox"; done
"$tars_root/.tars-run/sandbox/usr/bin/bwrap" --ro-bind / / -- /bin/true
"$tars_root/.tars-run/sandbox/usr/bin/socat" -V
