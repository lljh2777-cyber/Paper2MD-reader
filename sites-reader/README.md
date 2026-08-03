# Paper2MD Reader for Codex Sites

This directory is the Codex Sites host shell for the independent Local Reader.
It imports the Reader implementation from `../local-reader` and the shared,
host-neutral core from `../src`; the Obsidian plugin remains a separate host.

The hosted application is client-only from the Reader's perspective. A user
chooses a local Paper2MD package directory, and the browser reads the selected
files without sending the paper package to an application backend.

## Public-host security boundary

- The Worker accepts only `GET` and `HEAD`; mutation methods return `405`.
- The unused `/_vinext/image` server-side image optimizer is disabled.
- Every Worker response receives CSP, anti-framing, MIME-sniffing, referrer,
  browser-permission, cross-origin, and HSTS headers.
- Markdown may link to ordinary external pages, but rendered resources must be
  bounded files inside the user-selected package.
- `vinext start` is a framework preview server. Public-release validation must
  exercise the generated Worker in `dist/server/wrangler.json`.

## Local development

```powershell
npm.cmd install
npm.cmd run dev
```

## Production build

```powershell
npm.cmd run build
```

The Sites-compatible output is written to `dist/` and includes the worker
entrypoint and `.openai/hosting.json`.

Before changing site visibility, run the repository tests plus:

```powershell
npm.cmd audit --json
npm.cmd exec tsc -- --noEmit
npm.cmd run build
```
