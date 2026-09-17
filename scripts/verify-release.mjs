import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = path.join(root, "release");
const artifacts = [
  "Context Prompt Assistant-0.3.0-x64-portable.exe",
  "Context Prompt Assistant-0.3.0-x64-setup.exe",
];

const rows = [];
for (const name of artifacts) {
  const file = path.join(releaseDir, name);
  if (!fs.existsSync(file)) throw new Error(`missing release artifact: ${name}`);
  const stat = fs.statSync(file);
  if (stat.size < 10 * 1024 * 1024) throw new Error(`release artifact is unexpectedly small: ${name}`);
  const hash = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  rows.push(`${hash}  ${name}`);
}

console.log(`Verified ${rows.length} Windows release artifacts in ${releaseDir}`);
console.log(rows.join("\n"));
