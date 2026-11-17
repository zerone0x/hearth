#!/usr/bin/env bash
# Download the Bifrost gateway binary the tests run against (decision 0046),
# checked against a pinned SHA-256. Never committed; the compose install uses
# the image pinned by digest in deploy/compose.yaml instead.
#
# Usage: scripts/fetch-bifrost.sh <dir>    prints the binary's path
set -euo pipefail

version="v2.5.1"
url="https://downloads.getmaxim.ai/bifrost/${version}/linux/amd64/bifrost-http"
sha256="2b629808bdd54dca5abb38f0e62f6250e7fbd8c336c45d568d83d683974c0734"

dir="${1:?usage: $0 <dir>}"
[ "$(uname -s)-$(uname -m)" = "Linux-x86_64" ] ||
  { echo "fetch-bifrost: only linux/amd64 is pinned" >&2; exit 2; }
mkdir -p "$dir"
bin="$dir/bifrost-http-${version}"
if ! { [ -x "$bin" ] && echo "${sha256}  ${bin}" | sha256sum -c --quiet - >/dev/null 2>&1; }; then
  tmp="$(mktemp "$dir/.bifrost.XXXXXX")"
  curl -fsSL --retry 3 -o "$tmp" "$url"
  echo "${sha256}  ${tmp}" | sha256sum -c --quiet - ||
    { rm -f "$tmp"; echo "fetch-bifrost: checksum mismatch for $url" >&2; exit 1; }
  chmod 0755 "$tmp"
  mv -f "$tmp" "$bin"
fi
echo "$bin"
