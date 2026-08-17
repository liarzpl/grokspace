# Releasing GrokSpace

How a signed, notarized `.dmg` gets built, what has to be set up first, and — since
none of this can be verified from a Linux CI box — exactly what to look at the first
time it runs for real.

## What the pipeline does

[`.github/workflows/release.yml`](../.github/workflows/release.yml) runs on a pushed
tag matching `v*`:

1. **`checks`** calls [`ci.yml`](../.github/workflows/ci.yml), so a tagged build runs
   the same tests a pull request does. Not a copy of them — a copy drifts, and a
   release is the one build where a skipped test matters.
2. **`version`** checks that `tauri.conf.json`, `Cargo.toml` and `package.json` all
   say the same thing, and that the tag says it too. Tagging `v0.2.0` with the config
   still at `0.1.0` would produce a release full of files calling themselves 0.1.0, and
   nobody notices that until a user reports the wrong version.
3. **`macos`** builds a universal binary, signs it, notarizes it, staples the ticket,
   inspects the result, and attaches the DMG to a **draft** release.

The release is always a draft. Somebody reads the inspection output before anyone
downloads anything.

## What has to be set up first

An Apple Developer account, paid tier. The free tier cannot issue the certificate this
needs.

### The certificate

Use **Developer ID Application**, not Apple Development and not Apple Distribution.
Apple Development certificates only work on machines in your team's provisioning
profile — an app signed with one fails on every other Mac. Apple Distribution is for
the App Store.

The Tauri documentation's own example greps for `"Apple Development"`, which is wrong
for this purpose. Do not copy it.

1. Generate a Certificate Signing Request from Keychain Access on a Mac. Apple's terms
   require the signing to happen on Apple hardware, which is why this cannot be done
   from Linux.
2. In the Apple Developer portal, under Certificates, Identifiers & Profiles, create a
   certificate of type **Developer ID Application** and upload the CSR.
3. Download the `.cer` and open it to install it into the login keychain.
4. In Keychain Access, under My Certificates, expand the entry, right-click the
   **private key**, and export as `.p12` with a password.

### The secrets

Set these as repository secrets. The workflow checks for them and builds an
*explicitly labelled* unsigned DMG when they are absent, rather than pretending.

| Secret | What it is |
| --- | --- |
| `APPLE_CERTIFICATE` | The `.p12`, base64 encoded: `openssl base64 -A -in cert.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | The password used when exporting the `.p12` |
| `APPLE_SIGNING_IDENTITY` | The full identity string, e.g. `Developer ID Application: Your Name (A1B2C3D4E5)` |
| `APPLE_ID` | The Apple account email |
| `APPLE_PASSWORD` | An **app-specific password**, not the account password |
| `APPLE_TEAM_ID` | The ten-character team ID from the Apple Developer account page |

`APPLE_PASSWORD` is the one that catches people. The account password fails
notarization with an authentication error that reads like a typo in the email address.
Generate an app-specific password at [account.apple.com](https://account.apple.com)
under Sign-In and Security; it requires two-factor authentication on the account.

`security find-identity -v -p codesigning` prints the exact identity string to use.

## Releasing

Three files carry the version and none is derived from the others, so all three move
together. The `version` job refuses the build if they disagree, which is the point of
it: `tauri.conf.json` names the app and the DMG, `Cargo.toml` is what the binary
reports, and `package.json` is what `npm version` would bump.

```bash
# 1. Bump all three to the same value.
$EDITOR src-tauri/tauri.conf.json src-tauri/Cargo.toml package.json

# 2. Commit it, and tag what you committed.
git commit -am "Release 0.2.0"
git tag v0.2.0
git push origin main --tags
```

Then, when the run finishes, read the **Inspect what was actually produced** step
before publishing the draft.

## Trying it without publishing

Run the workflow manually from the Actions tab with **Build and sign, but publish
nothing** left ticked. It builds, signs and notarizes, and attaches the DMG as a
workflow artifact instead of creating a release.

Do this before the first real tag. Notarization is the step most likely to fail on a
fresh setup, and finding out during a dry run costs nothing.

## What to check the first time this runs for real

None of the signing path has ever executed. It cannot be: it needs a macOS runner,
Apple credentials, and a real tag. What follows is written from Apple's and Tauri's
documented behaviour, so treat the first run as the test.

Read the inspection step's output and expect:

- **Signature.** `Authority=Developer ID Application: ...` and
  `Authority=Developer ID Certification Authority`. If the authority says *Apple
  Development*, the wrong certificate type was used and the DMG will not open on
  anyone else's Mac.
- **Hardened runtime.** `flags=0x10000(runtime)` in the `codesign` output.
  Notarization is rejected without it. Tauri enables it by default, which is why
  `tauri.conf.json` does not set `hardenedRuntime` — but the flag is worth reading,
  because a missing one is the difference between a release and a support thread.
- **Gatekeeper.** `accepted` and `source=Notarized Developer ID`. If it says
  `source=Unnotarized Developer ID`, the app was signed but notarization did not
  happen — usually a missing `APPLE_TEAM_ID`.
- **Stapling.** `The validate action worked!` for at least one of the `.app` and the
  `.dmg`. Which one carries the ticket is a detail of the bundler, so the workflow
  checks both and neither failing alone is fatal.
- **Architectures.** `x86_64 arm64`. One alone means the universal build quietly
  became single-architecture, and half the audience downloads something that will not
  run.

Then, on a Mac that has never seen this certificate, download the DMG *through a
browser* — not `curl`, and not from a local build. That is the only way to get the
quarantine attribute that Gatekeeper actually reacts to, and therefore the only real
test of whether notarization worked.

### Failures worth expecting

- **`The specified item could not be found in the keychain`** — `APPLE_CERTIFICATE` or
  its password is wrong, or the `.p12` was exported without its private key. Export
  the key, not the certificate.
- **Notarization hangs, then times out** — Apple's service queues submissions and can
  take a while. The build has not failed; check
  [Apple's system status](https://developer.apple.com/system-status/) before assuming
  a configuration problem.
- **`Team is not yet configured for notarization`** — the account has not accepted the
  current developer agreements. Log into the developer portal and accept them.

## Why `tauri.conf.json` needed no changes for this

Worth writing down, because the obvious instinct is to add configuration and every
candidate turns out to be dead:

- **`macOS.hardenedRuntime`** is already `true` by default, and notarization requires
  it. Setting it explicitly would be a line that reads as load-bearing and is not.
- **`macOS.dmg`** — the window size and icon positions default to exactly the
  conventional values (660×400, app at 180,170, Applications at 480,170). Restating
  them configures nothing.
- **`bundle.homepage`** and **`bundle.publisher`** only apply to `deb`, `rpm`, `nsis`
  and `msi`. This project builds `dmg` and `app`.
- **`macOS.providerShortName`** is only needed when an Apple ID belongs to more than
  one provider, and `APPLE_TEAM_ID` already resolves that.

So the config is untouched. If you find yourself adding a key here, check its
`Supported bundle targets` line in the [schema](https://schema.tauri.app/config/2)
first.

## Known gaps

- **No entitlements file.** GrokSpace spawns child processes — a pty, `grok`, `git` —
  and hardened runtime permits that; child processes are separate and are not subject
  to the parent's restrictions. The web view's JIT belongs to WebKit's own process,
  signed by Apple. So no entitlement is currently justified. The symptom that would
  change this is the app launching and immediately dying with a code-signing error in
  Console; the fix would be an entitlements plist wired to
  `bundle.macOS.entitlements`.
- **No licence.** The repository declares no licence anywhere — no `LICENSE` file, and
  nothing in `package.json` or `Cargo.toml`. `bundle.license` and `bundle.copyright`
  are worth setting before a public release, but neither can be chosen on the
  repository owner's behalf, so both are left unset rather than invented.
- **No updater.** Tauri can sign and serve updates, which needs its own key pair and a
  place to host `latest.json`. A tagged draft release is the whole distribution story
  for now.
- **macOS only.** The Linux and Windows bundles are not built. The app compiles and its
  tests run on Linux — that is what CI does — but the pty and window behaviour have
  only been exercised on the two platforms this project actually targets.
