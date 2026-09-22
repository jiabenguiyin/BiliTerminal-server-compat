"use strict";

const fs = require("fs");
const path = require("path");

const root = process.argv[2];
const importedDir = process.argv[3];
if (!root || !importedDir) {
  throw new Error("usage: restore-announcement-history.js ROOT IMPORTED_DIR");
}

const configPath = path.join(root, "data", "config.json");
const sources = {
  1: path.join(root, "data", "config.json.bak.1779763144"),
  2: path.join(importedDir, "1.0.0.json"),
  3: path.join(importedDir, "1.0.1.json"),
  4: path.join(importedDir, "1.0.2.json"),
  5: `${root}.backup-20260605201511/data/config.json`,
  6: path.join(root, "data", "config.example.json"),
  7: path.join(root, "data", "config.json.bak-20260613-105"),
  10: path.join(importedDir, "1.0.6-failover.json")
};

function readAnnouncement(file) {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(parsed.announcements) || parsed.announcements.length === 0) {
    throw new Error(`announcement missing from ${file}`);
  }
  return parsed.announcements[0];
}

const stat = fs.statSync(configPath);
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const current = Array.isArray(config.announcements) ? config.announcements : [];
const restored = Object.entries(sources).map(([id, file]) => ({
  ...readAnnouncement(file),
  id: Number(id)
}));
const overrides = new Map();
for (const id of [10, 11]) {
  const item = JSON.parse(
    fs.readFileSync(path.join(root, "deploy", `announcement-${id}.json`), "utf8")
  );
  overrides.set(id, item);
}

const restoredIds = new Set(restored.map((item) => item.id));
config.announcements = [
  ...restored,
  ...current.filter((item) => !restoredIds.has(Number(item.id)))
]
  .map((item) => overrides.get(Number(item.id)) || item)
  .sort((a, b) => Number(a.id) - Number(b.id));

const ids = config.announcements.map((item) => Number(item.id));
if (new Set(ids).size !== ids.length) {
  throw new Error("duplicate announcement ids after recovery");
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = `${configPath}.bak-before-announcement-recovery-${stamp}`;
const tempPath = `${configPath}.tmp-${process.pid}`;
fs.copyFileSync(configPath, backupPath);
fs.writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, { mode: stat.mode });
JSON.parse(fs.readFileSync(tempPath, "utf8"));
fs.renameSync(tempPath, configPath);
fs.chownSync(configPath, stat.uid, stat.gid);
fs.chmodSync(configPath, stat.mode);

console.log(JSON.stringify({
  backupPath,
  announcements: config.announcements.map(({ id, ctime, title }) => ({ id, ctime, title }))
}, null, 2));
