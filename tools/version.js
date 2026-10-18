#!/usr/bin/env node
// Uso:  node tools/version.js patch | minor | major
// Como `npm version`: sube la versión visible (APP_SEMVER) y el número interno del caché
// (APP_VER en app/index.html y CACHE en app/sw.js, que tienen que coincidir).
const fs = require("fs"), path = require("path");
const kind = process.argv[2];
if (!["patch", "minor", "major"].includes(kind)) { console.error("Uso: node tools/version.js patch|minor|major"); process.exit(1); }
const root = path.join(__dirname, ".."), html = path.join(root, "app/index.html"), sw = path.join(root, "app/sw.js");
let h = fs.readFileSync(html, "utf8"), s = fs.readFileSync(sw, "utf8");
const sv = /var APP_SEMVER="(\d+)\.(\d+)\.(\d+)"/.exec(h), iv = /var APP_VER="holdy-v(\d+)"/.exec(h), cv = /const CACHE = "holdy-v(\d+)"/.exec(s);
if (!sv || !iv || !cv) { console.error("No encontré APP_SEMVER, APP_VER o CACHE."); process.exit(1); }
let [M, m, p] = sv.slice(1).map(Number);
if (kind === "major") { M++; m = 0; p = 0; } else if (kind === "minor") { m++; p = 0; } else p++;
const n = Math.max(+iv[1], +cv[1]) + 1, semver = `${M}.${m}.${p}`;
h = h.replace(sv[0], `var APP_SEMVER="${semver}"`).replace(iv[0], `var APP_VER="holdy-v${n}"`);
s = s.replace(cv[0], `const CACHE = "holdy-v${n}"`);
fs.writeFileSync(html, h); fs.writeFileSync(sw, s);
console.log(`Versión ${sv.slice(1).join(".")} → ${semver}  (interno holdy-v${n})`);
