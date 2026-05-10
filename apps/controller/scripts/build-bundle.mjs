/**
 * Produces two self-contained ESM bundles for the controller sidecar:
 *
 *   dist/index.js    – controller server
 *   dist/clawhub.js  – clawhub CLI (invoked as a subprocess)
 *
 * Prereqs: `@nexu/shared` must be built (`packages/shared/dist/` present)
 *          so esbuild can resolve its package exports.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { build } from "esbuild";

const require = createRequire(import.meta.url);

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

const cjsRequireShim = [
  'import { createRequire as __bundleCR } from "node:module";',
  "const require = __bundleCR(import.meta.url);",
].join("\n");

const shared = {
  platform: "node",
  format: "esm",
  sourcemap: "external",
  metafile: true,
  bundle: true,
  logLevel: "info",
  banner: { js: cjsRequireShim },
};

const controllerResult = await build({
  ...shared,
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
});

const clawhubEntry = require.resolve("clawhub/dist/cli.js");
const clawhubResult = await build({
  ...shared,
  entryPoints: [clawhubEntry],
  outfile: "dist/clawhub.js",
});

await writeFile(
  "dist/metafile-controller.json",
  JSON.stringify(controllerResult.metafile),
);
await writeFile(
  "dist/metafile-clawhub.json",
  JSON.stringify(clawhubResult.metafile),
);
