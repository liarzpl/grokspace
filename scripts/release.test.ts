import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The release workflow's decisions, run rather than read.
 *
 * `release.yml` cannot be executed to find out whether it works: it needs a macOS
 * runner, Apple credentials, and a tag it would then publish. So the parts of it that
 * decide anything were moved into two shell scripts, and this runs those — which turns
 * "written from the documentation and never executed" into "the Apple half is
 * unverified", a much smaller claim.
 *
 * Tested from vitest rather than a bash harness so the repository keeps one test
 * command. It shells out; there is nothing here for jsdom to do.
 */

const root = join(import.meta.dirname, "..");

interface Ran {
  status: number;
  stdout: string;
  stderr: string;
}

function run(script: string, args: string[] = [], env: Record<string, string> = {}): Ran {
  try {
    const stdout = execFileSync(join(root, "scripts", script), args, {
      encoding: "utf8",
      env: { ...process.env, ...env },
      // Captured rather than inherited: several of these cases fail on purpose, and
      // their complaints belong in the assertion rather than in the test output.
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status: number; stdout: string; stderr: string };
    return { status: failure.status, stdout: failure.stdout, stderr: failure.stderr };
  }
}

/** A checkout with the three version-carrying files set to whatever is asked for. */
function checkout(versions: { config: string; package: string; cargo: string }): string {
  const dir = mkdtempSync(join(tmpdir(), "grokspace-release-"));
  mkdirSync(join(dir, "src-tauri"));
  writeFileSync(
    join(dir, "src-tauri", "tauri.conf.json"),
    JSON.stringify({ version: versions.config }),
  );
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: versions.package }));
  writeFileSync(
    join(dir, "src-tauri", "Cargo.toml"),
    // Shaped like the real one, dependency version and all, because the extraction has
    // to pick the package's version and not the first one it happens to see.
    `[package]\nname = "grokspace"\nversion = "${versions.cargo}"\n\n[dependencies]\ntauri-build = { version = "2", features = [] }\n`,
  );
  return dir;
}

const agreed = (version: string) => ({ config: version, package: version, cargo: version });

describe("release-version.sh", () => {
  it("prints the version when the three files and the tag all agree", () => {
    const ran = run("release-version.sh", ["v1.2.3"], {
      RELEASE_ROOT: checkout(agreed("1.2.3")),
    });

    expect(ran.status).toBe(0);
    expect(ran.stdout.trim()).toBe("1.2.3");
  });

  it("checks only the files when no tag is given, which is the dry run's case", () => {
    const ran = run("release-version.sh", [], { RELEASE_ROOT: checkout(agreed("1.2.3")) });

    expect(ran.status).toBe(0);
    expect(ran.stdout.trim()).toBe("1.2.3");
  });

  it("refuses a tag that does not match, and says what to do", () => {
    // Otherwise a v0.2.0 release ships full of files calling themselves 0.1.0, and
    // nobody notices until a user reports the wrong version.
    const ran = run("release-version.sh", ["v0.2.0"], {
      RELEASE_ROOT: checkout(agreed("0.1.0")),
    });

    expect(ran.status).not.toBe(0);
    expect(ran.stderr).toContain("does not match");
    expect(ran.stderr).toContain("tag v0.1.0 instead");
  });

  it.each([
    ["package.json", { config: "1.0.0", package: "1.0.1", cargo: "1.0.0" }],
    ["Cargo.toml", { config: "1.0.0", package: "1.0.0", cargo: "0.9.0" }],
    ["tauri.conf.json", { config: "2.0.0", package: "1.0.0", cargo: "1.0.0" }],
  ])("refuses the build when %s disagrees with the others", (_which, versions) => {
    const ran = run("release-version.sh", ["v1.0.0"], { RELEASE_ROOT: checkout(versions) });

    expect(ran.status).not.toBe(0);
    expect(ran.stderr).toContain("must match");
  });

  it("reads the package's version, not a dependency's", () => {
    // `tauri-build = { version = "2" }` sits below it in the real file, and an
    // unanchored match would have taken that instead.
    const ran = run("release-version.sh", [], { RELEASE_ROOT: checkout(agreed("3.4.5")) });

    expect(ran.stdout.trim()).toBe("3.4.5");
  });

  it("agrees with the versions actually in this repository", () => {
    // No RELEASE_ROOT, so it reads the real files. This is the check that fails if
    // somebody bumps one of the three and forgets the others.
    const ran = run("release-version.sh");

    expect(ran.status, ran.stderr).toBe(0);
    expect(ran.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

/** `key=value` lines, ignoring the heredoc body. */
function outputs(stdout: string): Record<string, string> {
  const pairs: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    if (line.startsWith("notes<<")) break;
    const at = line.indexOf("=");
    if (at > 0) pairs[line.slice(0, at)] = line.slice(at + 1);
  }
  return pairs;
}

const SECRETS = {
  APPLE_SIGNING_IDENTITY: "Developer ID Application: X (Y)",
  APPLE_CERTIFICATE: "base64",
  APPLE_ID: "dev@example.com",
};

describe("release-plan.sh", () => {
  it("signs and publishes when the secrets are there and this is not a dry run", () => {
    const ran = run("release-plan.sh", [], { VERSION: "0.2.0", ...SECRETS });

    expect(outputs(ran.stdout)).toMatchObject({
      signed: "true",
      tag: "v0.2.0",
      name: "GrokSpace v0.2.0",
    });
  });

  it("publishes nothing on a dry run, which is the trap this script exists for", () => {
    // In GitHub expressions `dry-run && '' || tag` takes the other branch, because an
    // empty string is falsy — so written in YAML a dry run publishes. tauri-action
    // publishes nothing only when BOTH of these are empty.
    const ran = run("release-plan.sh", [], { VERSION: "0.2.0", DRY_RUN: "true", ...SECRETS });
    const got = outputs(ran.stdout);

    expect(got.tag).toBe("");
    expect(got.name).toBe("");
    expect(got.signed).toBe("true");
  });

  it("still signs on a dry run, since that is the thing a dry run is for", () => {
    const ran = run("release-plan.sh", [], { VERSION: "0.2.0", DRY_RUN: "true", ...SECRETS });

    expect(outputs(ran.stdout).signed).toBe("true");
  });

  it.each(["APPLE_SIGNING_IDENTITY", "APPLE_CERTIFICATE", "APPLE_ID"])(
    "reports an unsigned build when %s alone is missing",
    (missing) => {
      // tauri-action needs all three and quietly produces an unsigned bundle otherwise,
      // so any one of them missing has to be caught.
      const ran = run("release-plan.sh", [], {
        VERSION: "0.2.0",
        ...SECRETS,
        [missing]: "",
      });

      expect(outputs(ran.stdout).signed).toBe("false");
    },
  );

  it("says plainly in the notes that an unsigned build is unsigned", () => {
    // Shipping one that looks signed is the worst option: Gatekeeper refuses it and the
    // app looks broken rather than unsigned.
    const ran = run("release-plan.sh", [], { VERSION: "0.2.0" });

    expect(ran.stdout).toContain("**This build is unsigned.**");
    expect(ran.stdout).toContain("xattr -dr com.apple.quarantine");
  });

  it("claims notarization only when it actually happened", () => {
    const signed = run("release-plan.sh", [], { VERSION: "0.2.0", ...SECRETS });

    expect(signed.stdout).toContain("notarized by Apple");
    expect(signed.stdout).not.toContain("unsigned");
  });

  it("closes the heredoc, or the release notes swallow every output after them", () => {
    const ran = run("release-plan.sh", [], { VERSION: "0.2.0", ...SECRETS });

    expect(ran.stdout).toContain("notes<<RELEASE_NOTES_END");
    expect(ran.stdout.trimEnd().endsWith("RELEASE_NOTES_END")).toBe(true);
  });

  it("refuses to run without a version rather than releasing an empty one", () => {
    const ran = run("release-plan.sh");

    expect(ran.status).not.toBe(0);
    expect(ran.stderr).toContain("VERSION");
  });
});
