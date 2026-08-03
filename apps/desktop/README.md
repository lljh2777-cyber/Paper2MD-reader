# Paper2MD Reader Desktop

```powershell
npm install
npx install-electron --no
npm run desktop:build
npm run desktop:start
```

Electron 43 downloads its platform binary on demand. Run `npx install-electron
--no` explicitly when the first start cannot reach the Electron download host.

The app expects `paper2md` to be installed on `PATH`. Developers may set
`PAPER2MD_EXECUTABLE` in the Electron main-process environment to a trusted
Paper2MD executable path. This value is never accepted from renderer content.

The phase-one desktop build is a development application, not a signed installer.
Packaging and code signing should use a dedicated Electron Forge release step.
