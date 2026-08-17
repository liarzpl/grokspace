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
    environment: "node",
    // `scripts/` is here for the release workflow's shell. That workflow cannot be run
    // to find out whether it works — it needs a macOS runner, Apple credentials and a
    // tag it would then publish — so the parts of it that decide anything live in
    // scripts and are tested like anything else. One test command for the repository.
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
  },
});
