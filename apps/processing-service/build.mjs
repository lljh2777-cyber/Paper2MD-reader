import { build } from "esbuild";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname);
await Promise.all([
  ["server.ts", "server.mjs"],
  ["mcp-server.ts", "mcp-server.mjs"]
].map(([entry, output]) => build({
  entryPoints: [resolve(root, "src", entry)],
  outfile: resolve(root, "dist", output),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false
})));
