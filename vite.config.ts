import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Tauri injects TAURI_DEV_HOST when developing against a physical device.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Tauri owns the terminal output, so Vite must not wipe it.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    // The macOS WKWebView baseline; Tauri sets TAURI_ENV_PLATFORM during builds.
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
  },
  test: {
    // One command still runs everything. Component files need a DOM (TEST-001);
    // store/lib tests stay on node so they do not grow a `window` they were
    // written without. `scripts/` is here for the release workflow's shell —
    // that workflow cannot be run to find out whether it works (macOS runner,
    // Apple credentials, a tag it would then publish), so the parts that decide
    // anything live in scripts and are tested like anything else.
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "components",
          environment: "jsdom",
          include: ["src/**/*.test.tsx"],
          setupFiles: ["./src/test/setup.ts"],
        },
      },
    ],
    // HTML report only (TEST-010). Do not add a coverage.thresholds gate: a
    // drop must not fail CI. Scope is the already-tested lib/stores surface;
    // components wait on TEST-001.
    coverage: {
      provider: "v8",
      reporter: ["html", "text-summary"],
      reportsDirectory: "coverage",
      include: ["src/lib/**", "src/stores/**"],
      exclude: ["**/*.test.ts", "**/*.test.tsx"],
    },
  },
});
