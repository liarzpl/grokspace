#!/usr/bin/env bash
#
# Checks that every file carrying the version agrees, and that a tag agrees with them.
#
# A script rather than lines inside release.yml, for one reason: the release workflow
# cannot be run to find out whether it works. It needs a macOS runner, Apple
# credentials, and a tag it would then publish. Shell in a `run:` block is checked by
# shellcheck for syntax and by nothing at all for behaviour, so the parts that make
# decisions live here where `npm test` can run them.
#
# Usage: release-version.sh [<tag>]
#
# Prints the agreed version on stdout. Exits non-zero, with the reason on stderr, when
# the files disagree or the tag does not match. Omit the tag to check only the files.
set -euo pipefail

# Overridable so the tests can point it at a directory of crafted version files. There
# is no other caller: the workflow runs it from the checkout with no override.
root="${RELEASE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
tag="${1:-}"

# Three files, none derived from the others: tauri.conf.json names the app and the DMG,
# Cargo.toml is what the binary reports, package.json is what `npm version` bumps.
config="$(jq -er .version "$root/src-tauri/tauri.conf.json")"
package="$(jq -er .version "$root/package.json")"
# The anchor matters. Without it this would also match `tauri-build = { version = "2" }`.
cargo="$(sed -n 's/^version = "\(.*\)"$/\1/p' "$root/src-tauri/Cargo.toml" | head -1)"

if [ -z "$cargo" ]; then
  echo "could not find a version in src-tauri/Cargo.toml" >&2
  exit 1
fi

if [ "$config" != "$package" ] || [ "$config" != "$cargo" ]; then
  {
    echo "these three versions must match, and do not:"
    echo "  tauri.conf.json  $config"
    echo "  package.json     $package"
    echo "  Cargo.toml       $cargo"
    echo "Bump all three together."
  } >&2
  exit 1
fi

# A tag disagreeing with the config would publish a v0.2.0 release full of files that
# call themselves 0.1.0 — the kind of mistake nobody notices until a user reports the
# wrong version.
if [ -n "$tag" ] && [ "$tag" != "v$config" ]; then
  {
    echo "tag $tag does not match version $config"
    echo "Bump the three files and re-tag, or tag v$config instead."
  } >&2
  exit 1
fi

echo "$config"
