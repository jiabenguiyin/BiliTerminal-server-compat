"use strict";

const fs = require("fs");
const path = require("path");

const configPath = path.resolve(__dirname, "..", "data", "config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

if (!config.relay || !Array.isArray(config.relay.allowedHosts)) {
  throw new Error("relay.allowedHosts is missing from data/config.json");
}

const rule = "upos-*.akamaized.net";
if (!config.relay.allowedHosts.includes(rule)) {
  const insertAfter = config.relay.allowedHosts.indexOf("*.bilivideo.cn");
  config.relay.allowedHosts.splice(insertAfter >= 0 ? insertAfter + 1 : 0, 0, rule);
  fs.writeFileSync(`${configPath}.tmp`, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  fs.renameSync(`${configPath}.tmp`, configPath);
  console.log(`Added ${rule} to ${configPath}`);
} else {
  console.log(`${rule} is already configured`);
}
