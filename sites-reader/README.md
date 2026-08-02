# Paper2MD Reader for Codex Sites

This directory is the Codex Sites host shell for the independent Local Reader.
It imports the Reader implementation from `../local-reader` and the shared,
host-neutral core from `../src`; the Obsidian plugin remains a separate host.

The hosted application is client-only from the Reader's perspective. A user
chooses a local Paper2MD package directory, and the browser reads the selected
files without sending the paper package to an application backend.

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
