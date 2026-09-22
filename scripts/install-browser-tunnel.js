"use strict";

// Run on the server only after installing the staged dependencies and passing tests.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const root = "/opt/biliterminal-server-compat";
const stage = path.resolve(process.argv[2] || "");
const serverFile = path.join(root, "server.js");
const oldServer = fs.readFileSync(serverFile, "utf8");
const expectedHash = process.argv[3];
const actualHash = crypto.createHash("sha256").update(oldServer).digest("hex");
if (actualHash !== expectedHash) throw new Error("Server changed; inspect before deploying");
const marker = "const server = http.createServer(handleRequest);";
if (oldServer.split(marker).length !== 2) throw new Error("Unexpected server entry point");
const configFile = path.join(root, "data/config.json");
const oldConfig = fs.readFileSync(configFile, "utf8");
const config = JSON.parse(oldConfig);
if (!config.relay || !config.relay.enabled || !config.relay.token) throw new Error("Relay is not configured");
const backup = path.join(root, "backups", "browser-tunnel-" + new Date().toISOString().replace(/[:.]/g, "-"));
fs.mkdirSync(backup, { recursive: true });
for (const name of ["server.js", "package.json", "package-lock.json", "browser-tunnel.js"]) {
  const source = path.join(root, name);
  if (fs.existsSync(source)) fs.copyFileSync(source, path.join(backup, name));
}
fs.writeFileSync(path.join(backup, "config.json"), oldConfig);
const incoming = JSON.parse(fs.readFileSync(path.join(stage, "package.json"), "utf8"));
const packageFile = path.join(root, "package.json");
const pkg = JSON.parse(fs.readFileSync(packageFile, "utf8"));
pkg.dependencies = { ...pkg.dependencies, ...incoming.dependencies };
fs.cpSync(path.join(stage, "node_modules/ws"), path.join(root, "node_modules/ws"), { recursive: true });
fs.cpSync(path.join(stage, "node_modules/ipaddr.js"), path.join(root, "node_modules/ipaddr.js"), { recursive: true });
fs.copyFileSync(path.join(stage, "browser-tunnel.js"), path.join(root, "browser-tunnel.js"));
fs.writeFileSync(packageFile, JSON.stringify(pkg, null, 2) + "\n");
config.browserRelay = { ...config.browserRelay, enabled: true };
fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n");
const updated = oldServer.replace(marker,
  `${marker}\nrequire("./browser-tunnel").attachBrowserTunnel(server, loadConfig);`);
fs.writeFileSync(serverFile, updated);
try {
  execFileSync(process.execPath, ["--check", serverFile]);
  execFileSync(process.execPath, ["--check", path.join(root, "browser-tunnel.js")]);
} catch (error) {
  fs.writeFileSync(serverFile, oldServer);
  fs.writeFileSync(configFile, oldConfig);
  throw error;
}
console.log("Installed browser tunnel. Backup: " + backup);
