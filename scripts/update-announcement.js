"use strict";

const fs = require("fs");
const path = require("path");

const root = process.argv[2];
const itemPaths = process.argv.slice(3);
if (!root || itemPaths.length === 0) {
  throw new Error("usage: update-announcement.js ROOT ITEM_JSON [ITEM_JSON...]");
}

const configPath = path.join(root, "data", "config.json");
const stat = fs.statSync(configPath);
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const replacements = itemPaths.map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
for (const replacement of replacements) {
  if (!Number.isSafeInteger(replacement.id) || !replacement.title || !replacement.content) {
    throw new Error("invalid announcement item");
  }
  const index = (config.announcements || []).findIndex(
    (item) => Number(item.id) === replacement.id
  );
  if (index < 0) {
    throw new Error(`announcement id ${replacement.id} not found`);
  }
  config.announcements[index] = replacement;
}
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const ids = replacements.map((item) => item.id).join("-");
const backupPath = `${configPath}.bak-before-announcement-${ids}-${stamp}`;
const tempPath = `${configPath}.tmp-${process.pid}`;
fs.copyFileSync(configPath, backupPath);
fs.writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, { mode: stat.mode });
JSON.parse(fs.readFileSync(tempPath, "utf8"));
fs.renameSync(tempPath, configPath);
fs.chownSync(configPath, stat.uid, stat.gid);
fs.chmodSync(configPath, stat.mode);

console.log(JSON.stringify({ backupPath, announcements: replacements }, null, 2));
