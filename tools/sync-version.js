#!/usr/bin/env node
// Lo corre `npm version patch|minor|major` (script "version" de package.json), antes del commit.
// Copia la versión de package.json a APP_SEMVER (lo que se ve en el menú) y sube el número
// interno del caché (APP_VER en app/index.html y CACHE en app/sw.js, que tienen que coincidir).
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, ".."), html = path.join(root, "app/index.html"), sw = path.join(root, "app/sw.js");
const version = require(path.join(root, "package.json")).version;
let h = fs.readFileSync(html, "utf8"), s = fs.readFileSync(sw, "utf8");
const sv = /var APP_SEMVER="[^"]*"/, iv = /var APP_VER="holdy-v(\d+)"/.exec(h), cv = /const CACHE = "holdy-v(\d+)"/.exec(s);
if (!sv.test(h) || !iv || !cv) { console.error("No encontré APP_SEMVER, APP_VER o CACHE."); process.exit(1); }
const n = Math.max(+iv[1], +cv[1]) + 1;
h = h.replace(sv, `var APP_SEMVER="${version}"`).replace(iv[0], `var APP_VER="holdy-v${n}"`);
s = s.replace(cv[0], `const CACHE = "holdy-v${n}"`);
fs.writeFileSync(html, h); fs.writeFileSync(sw, s);
console.log(`Holdy ${version} (interno holdy-v${n})`);
