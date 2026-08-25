import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("..", import.meta.url));
const files = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (["node_modules", ".git"].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.name.endsWith(".js") || entry.name.endsWith(".mjs")) files.push(path);
  }
}
await walk(root);
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || `Syntax error in ${file}\n`);
    process.exit(result.status || 1);
  }
}
const required = [
  "index.html",
  "app.js",
  "styles.css",
  "assets/wts-school-logo.jpg",
  "supabase/functions/attendance-scan/index.ts",
  "docs/ATTENDANCE-SYSTEM-ARCHITECTURE.md",
];
for (const file of required) await readFile(join(root, file));
console.log(`Checked ${files.length} JavaScript files and required production assets.`);
