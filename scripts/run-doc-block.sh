#!/usr/bin/env bash
# Runs the fenced code block tagged `<name>` in a Markdown file under
# `bash -euo pipefail` (decision 0020). Unlike `bash -c "$(doc-block.sh ...)"`,
# it fails when the block is missing, duplicated or empty: a failed command
# substitution inside an argument does not trip errexit, so that form would
# run an empty script and pass.
#
#   scripts/run-doc-block.sh [-x] docs/install.md install:up
#
# -x traces each command (leave it off for blocks that print secrets).
set -euo pipefail

trace=()
if [[ "${1:-}" == "-x" ]]; then
  trace=(-x)
  shift
fi
if [[ $# -ne 2 ]]; then
  echo "usage: $0 [-x] <markdown file> <block name>" >&2
  exit 64
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$("${here}/doc-block.sh" "$1" "$2")"
if [[ -z "${script//[[:space:]]/}" ]]; then
  echo "$0: block $2 in $1 is empty" >&2
  exit 1
fi
exec bash -euo pipefail "${trace[@]}" -c "${script}"
