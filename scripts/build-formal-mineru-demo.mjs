import { build } from "esbuild";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
if (process.cwd() !== repositoryRoot) {
  throw new Error("Run the formal demo builder from the repository root");
}
const bundled = await build({
  absWorkingDir: repositoryRoot,
  entryPoints: [resolve(repositoryRoot, "scripts", "build-formal-mineru-demo-entry.ts")],
  bundle: true,
  external: ["node:*"],
  format: "esm",
  logLevel: "silent",
  platform: "node",
  target: "node22",
  write: false
});
const output = bundled.outputFiles[0];
if (!output) throw new Error("Formal demo builder did not emit an executable bundle");
await import(`data:text/javascript;base64,${Buffer.from(output.contents).toString("base64")}`);
