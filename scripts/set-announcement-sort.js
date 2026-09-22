"use strict";

const fs = require("fs");
const path = require("path");

const root = process.argv[2];
if (!root) {
  throw new Error("usage: set-announcement-sort.js ROOT");
}

const serverPath = path.join(root, "server.js");
const stat = fs.statSync(serverPath);
const source = fs.readFileSync(serverPath, "utf8");
const oldExpression = ".sort((a, b) => (b.ctime - a.ctime) || (b.id - a.id));";
const newExpression = ".sort((a, b) => b.id - a.id);";

if (!source.includes(oldExpression) && !source.includes(newExpression)) {
  throw new Error("announcement sort expression not found");
}

if (source.includes(oldExpression)) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.copyFileSync(serverPath, `${serverPath}.bak-before-id-sort-${stamp}`);
  const tempPath = `${serverPath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, source.replace(oldExpression, newExpression), { mode: stat.mode });
  fs.renameSync(tempPath, serverPath);
  fs.chownSync(serverPath, stat.uid, stat.gid);
  fs.chmodSync(serverPath, stat.mode);
}

console.log("announcement sort uses descending id");
