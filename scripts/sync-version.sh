#!/usr/bin/env bash
#
# Writes Cargo.toml and tauri.conf.json from package.json.
#
# Three files used to be edited by hand. CI still refuses a mismatch
# (`release-version.sh`); this is how they stay in step. `package.json` is the
# source because `npm version` already knows how to bump it.
#
# Usage: sync-version.sh
#
# Overridable via RELEASE_ROOT so the tests can point it at a crafted checkout.
set -euo pipefail

root="${RELEASE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
version="$(jq -er .version "$root/package.json")"

if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-].*)?$ ]]; then
  echo "package.json version is not a semver: $version" >&2
  exit 1
fi

# Only the package's own version line. The first `^version = "` is that one;
# later lines are dependencies (`tauri-build = { version = "2" }`).
awk -v ver="$version" '
  BEGIN { done = 0 }
  /^version = "/ && !done {
    print "version = \"" ver "\""
    done = 1
    next
  }
  { print }
' "$root/src-tauri/Cargo.toml" >"$root/src-tauri/Cargo.toml.tmp"
mv "$root/src-tauri/Cargo.toml.tmp" "$root/src-tauri/Cargo.toml"

tmp="$(mktemp)"
jq --arg version "$version" '.version = $version' "$root/src-tauri/tauri.conf.json" >"$tmp"
mv "$tmp" "$root/src-tauri/tauri.conf.json"

echo "$version"
