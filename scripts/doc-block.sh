#!/usr/bin/env bash
# Prints the body of the fenced code block tagged `<name>` in a Markdown file,
# for CI to run docs/install.md verbatim (decision 0020). A tagged block opens
# with a fence whose info string is the language and then the name, for
# example "```sh install:up"; GitHub renders it as an ordinary sh block.
# Exits 1 when the file has no block with that name, 2 when it has several.
#
#   scripts/doc-block.sh docs/install.md install:up
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <markdown file> <block name>" >&2
  exit 64
fi
file="$1"
name="$2"

count="$(grep -cE "^\`\`\`[a-z]+ ${name}\$" "${file}" || true)"
if [[ "${count}" -eq 0 ]]; then
  echo "$0: no block named ${name} in ${file}" >&2
  exit 1
fi
if [[ "${count}" -gt 1 ]]; then
  echo "$0: ${count} blocks named ${name} in ${file}" >&2
  exit 2
fi
awk -v name="${name}" '
  inside && /^```[[:space:]]*$/ { exit }
  inside { print }
  $0 ~ "^```[a-z]+ " name "$" { inside = 1 }
' "${file}"
