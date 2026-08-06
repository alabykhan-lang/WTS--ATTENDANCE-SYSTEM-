import { build } from "esbuild";

await build({
  entryPoints: ["src/vendor-entry.js"],
  bundle: true,
  minify: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  outfile: "vendor.bundle.js",
  legalComments: "none",
});
