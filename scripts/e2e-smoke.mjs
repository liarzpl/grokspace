#!/usr/bin/env node
/**
 * TEST-002 entry point.
 *
 * Runs the host smoke (fixture folder → shell pane → graph:demo → Graph
 * snapshot). A WebView/Playwright drive of the Tauri window is skipped when
 * this machine has no display: Linux CI installs WebKitGTK so Tauri *links*,
 * not so a window can be driven.
 *
 *   npm run test:e2e
 *   GROKSPACE_E2E_WEBVIEW=1 npm run test:e2e   # still skips without DISPLAY
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { env, exit, stderr, stdout } from "node:process";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const cargoToml = join(repo, "src-tauri", "Cargo.toml");

function hasDisplay() {
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

function skipWebView() {
  if (env.GROKSPACE_E2E_WEBVIEW === "0") return true;
  if (env.GROKSPACE_E2E_WEBVIEW === "1") {
    if (process.platform === "darwin") return false;
    return !hasDisplay();
  }
  // Default: do not require a WebView. The host smoke is the CI path.
  return true;
}

if (skipWebView()) {
  stdout.write(
    "TEST-002: skipping WebView/Playwright (no usable WebView on this runner).\n" +
      "Running the host smoke: fixture folder, shell pane, graph:demo → Graph.\n",
  );
} else {
  stdout.write(
    "TEST-002: WebView is present, but this smoke is the host path " +
      "(fixture → pane → graph:demo). Drive the window by hand with " +
      "`npm run tauri:dev` if you want the panel itself.\n",
  );
}

const result = spawnSync(
  "cargo",
  [
    "test",
    "--manifest-path",
    cargoToml,
    "--lib",
    "e2e_fixture_shell_pane_then_graph_demo",
    "--",
    "--nocapture",
  ],
  {
    cwd: repo,
    env: { ...env, GROKSPACE_E2E: "1" },
    stdio: "inherit",
  },
);

if (result.error) {
  stderr.write(`TEST-002: could not start cargo: ${result.error.message}\n`);
  exit(1);
}

exit(result.status ?? 1);
