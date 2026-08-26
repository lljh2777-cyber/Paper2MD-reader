# Paper2MD Reader Web

```powershell
npm install
npm run web:dev
npm run web:build
```

The Web host uses browser directory APIs only. It does not import Electron,
Node filesystem or child-process capabilities, and package content remains local.

Saved Web Clipper Markdown and HTML can be imported with local image files. HTML
is converted only into an in-memory reading projection; scripts, active embeds,
remote images, unsafe protocols and missing resources are omitted. The source
document is never rewritten.
