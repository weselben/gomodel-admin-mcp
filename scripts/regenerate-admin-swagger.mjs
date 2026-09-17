/**
 * Regenerate spec/admin-swagger.json from the upstream gomodel Swagger 2.0
 * spec (swag init output). Filters paths to /admin/* and keeps only
 * definitions reachable from those paths (transitive $ref closure).
 *
 * Usage: bun scripts/regenerate-admin-swagger.mjs <upstream-swagger.json> <out.json>
 *
 * Replaces (does not merge) all top-level fields with the upstream values;
 * spec shape is identical to the upstream swagger.json except for the
 * pruned paths and definitions.
 */

import { readFileSync, writeFileSync } from "node:fs";

const [, , input, output] = process.argv;
if (!input || !output) {
  console.error("usage: bun scripts/regenerate-admin-swagger.mjs <swagger.json> <out.json>");
  process.exit(2);
}

const src = JSON.parse(readFileSync(input, "utf8"));

// 1. Keep only /admin/* paths.
const adminPaths = {};
for (const [p, item] of Object.entries(src.paths ?? {})) {
  if (p.startsWith("/admin/")) adminPaths[p] = item;
}

// 2. Transitive $ref closure over definitions.
const REF = /^#\/definitions\/([^"]+)$/;
const needed = new Set();
function visit(value) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const v of value) visit(v);
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    if (k === "$ref" && typeof v === "string") {
      const m = v.match(REF);
      if (m) needed.add(m[1]);
    } else if (typeof v === "object") {
      visit(v);
    }
  }
}
for (const item of Object.values(adminPaths)) visit(item);
let grew = true;
while (grew) {
  grew = false;
  for (const name of [...needed]) {
    const def = src.definitions?.[name];
    if (!def) continue;
    const before = needed.size;
    visit(def);
    if (needed.size > before) grew = true;
  }
}

const definitions = {};
for (const n of needed) if (src.definitions?.[n]) definitions[n] = src.definitions[n];

const out = {
  ...src,
  paths: adminPaths,
  definitions,
};

writeFileSync(output, JSON.stringify(out, null, 1) + "\n");
console.log(`paths: ${Object.keys(adminPaths).length}, definitions: ${Object.keys(definitions).length}`);
