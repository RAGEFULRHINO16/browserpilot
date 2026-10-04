import { build } from "esbuild";
import { chmod } from "node:fs/promises";

await build({
  entryPoints: { "cli/index": "cli/index.ts", "companion/server": "companion/server.ts" },
  outdir: "dist", bundle: true, packages: "external", platform: "node", format: "esm", target: "node22",
  sourcemap: false, logLevel: "info",
});
await chmod("dist/cli/index.js", 0o755);
