# Security

## Reporting a vulnerability

Report vulnerabilities through [GitHub Security Advisories](https://github.com/liarzpl/grokspace/security/advisories/new). That is the preferred channel so the report stays private until a fix is ready.

Do not open a public issue for a vulnerability.

## Secrets

Never commit:

- `XAI_API_KEY`
- Apple signing and notarization secrets (`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`)
- `.env` or `.env.*` files (they are gitignored)

[`.env.example`](.env.example) is the template. Copy it locally; do not put real keys in the example.
