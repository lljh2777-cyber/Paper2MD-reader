/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: "com.paper2md.reader",
  productName: "Paper2MD Reader",
  electronVersion: "43.2.0",
  directories: {
    app: "apps/desktop",
    output: process.env.PAPER2MD_DESKTOP_OUTPUT || "apps/desktop/out"
  },
  files: [
    "package.json",
    "dist/main.cjs",
    "dist/preload.cjs",
    "dist/reader-contract-worker.cjs",
    "dist/renderer/index.html",
    "dist/renderer/assets/index.js",
    "dist/renderer/assets/index.css",
    "dist/renderer/assets/*.woff",
    "dist/renderer/assets/*.woff2",
    "dist/renderer/assets/*.ttf",
    "!node_modules/**/*"
  ],
  asar: true,
  asarUnpack: ["dist/reader-contract-worker.cjs"],
  npmRebuild: false,
  forceCodeSigning: false,
  publish: null,
  win: {
    executableName: "Paper2MD Reader",
    target: [
      { target: "nsis", arch: ["x64"] },
      { target: "portable", arch: ["x64"] }
    ]
  },
  nsis: {
    artifactName: "Paper2MD-Reader-Setup-${version}-${arch}.${ext}",
    oneClick: false,
    perMachine: false,
    allowElevation: true,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "Paper2MD Reader",
    uninstallDisplayName: "Paper2MD Reader"
  },
  portable: {
    artifactName: "Paper2MD-Reader-Portable-${version}-${arch}.${ext}"
  }
};
