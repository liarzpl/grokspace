#!/usr/bin/env bash
#
# Decides what a release build is: signed or not, published or not, and what its notes
# say. Writes `key=value` lines, and a heredoc-delimited `notes`, in the format
# `$GITHUB_OUTPUT` takes.
#
# This is here rather than in release.yml because the obvious way to write it in YAML is
# wrong. In GitHub expressions:
#
#     tagName: ${{ inputs.dry-run && '' || format('v{0}', version) }}
#
# does not mean what it looks like. An empty string is falsy, so `||` takes the other
# branch and a dry run publishes a release. Shell has no such trap, and unlike a `${{ }}`
# expression it can be run by a test — which is the point, since the workflow around it
# cannot be.
#
# Reads: VERSION, DRY_RUN, APPLE_SIGNING_IDENTITY, APPLE_CERTIFICATE, APPLE_ID.
set -euo pipefail

version="${VERSION:?VERSION is required}"
dry_run="${DRY_RUN:-false}"
identity="${APPLE_SIGNING_IDENTITY:-}"
certificate="${APPLE_CERTIFICATE:-}"
apple_id="${APPLE_ID:-}"

# An unsigned DMG still builds and is still useful for testing. What it must not do is
# arrive looking signed: Gatekeeper refuses it, and the app then looks broken rather
# than unsigned. tauri-action signs only when all three of these are set, and quietly
# produces an unsigned bundle otherwise, so this checks rather than trusting.
if [ -n "$identity" ] && [ -n "$certificate" ] && [ -n "$apple_id" ]; then
  signed=true
else
  signed=false
fi
echo "signed=$signed"

# tauri-action publishes nothing when both of these are empty, which is what a dry run
# wants: everything up to and including notarization, and no release.
if [ "$dry_run" = "true" ]; then
  echo "tag="
  echo "name="
else
  echo "tag=v$version"
  echo "name=GrokSpace v$version"
fi

if [ "$signed" = "true" ]; then
  opening="Signed with a Developer ID certificate and notarized by Apple, so it opens by double-clicking."
else
  opening="**This build is unsigned.** macOS will refuse to open it by double-clicking. Right-click the app and choose Open, or run \`xattr -dr com.apple.quarantine /Applications/GrokSpace.app\`. Use it for testing only."
fi

cat <<OUTPUT
notes<<RELEASE_NOTES_END
$opening

Requires macOS 11 or later. Universal, so one download covers Apple Silicon and Intel.

GrokSpace runs \`grok\` from your own machine and keeps everything in \`~/.grokspace\`.
Agent sessions need the [\`grok\` CLI](https://docs.x.ai/build); the terminal grid works without it.
RELEASE_NOTES_END
OUTPUT
