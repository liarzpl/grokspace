# Security

## Reporting a vulnerability

Report vulnerabilities through [GitHub Security Advisories](https://github.com/liarzpl/grokspace/security/advisories/new). That is the preferred channel so the report stays private until a fix is ready.

Do not open a public issue for a vulnerability.

## Secrets

Never commit:

- `XAI_API_KEY`
- Apple signing and notarization secrets (`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`)
- `.env` or `.env.*` files (they are gitignored)

[`.env.example`](.env.example) names the optional key. Copying it to `.env` does **not** load it: there is no dotenv crate and no Tauri env plugin. Vite only injects `VITE_` / `TAURI_ENV_*` into the frontend, not into Rust. `acp.rs` reads `std::env::var("XAI_API_KEY")` from the process environment.

For `npm run tauri:dev`, export the key in the same shell:

```bash
export XAI_API_KEY=…
npm run tauri:dev
```

A packaged `.app` launched from Finder does not see a source-tree `.env`. Put the key in the user environment, or use `grok login`. Leave the key unset to use the cached token. Do not put real keys in the example.
