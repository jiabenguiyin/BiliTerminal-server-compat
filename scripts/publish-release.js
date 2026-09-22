"use strict";

const fs = require("fs");
const path = require("path");

const [root, versionName, versionCodeRaw, apkUrl, apkSha256, apkSizeRaw] = process.argv.slice(2);
const versionCode = Number(versionCodeRaw);
const apkSize = Number(apkSizeRaw);

if (!root || !versionName || !Number.isSafeInteger(versionCode) || !apkUrl ||
    !/^[a-f0-9]{64}$/i.test(apkSha256 || "") || !Number.isSafeInteger(apkSize)) {
  throw new Error("usage: publish-release.js ROOT VERSION_NAME VERSION_CODE APK_URL APK_SHA256 APK_SIZE");
}

const configPath = path.join(root, "data", "config.json");
const serverPath = path.join(root, "server.js");
const configStat = fs.statSync(configPath);
const serverStat = fs.statSync(serverPath);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const now = Math.floor(Date.now() / 1000);
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const serverSource = fs.readFileSync(serverPath, "utf8");
const defaultUpdateLog = [
  "- \u4fee\u590d\u4e86\u52a8\u6001\u90e8\u5206\u63a5\u53e3\u5931\u6548\u7684\u95ee\u9898",
  "- \u4fee\u590d\u4e86\u6536\u85cf\u5939\u5185\u7684\u89c6\u9891\u4e3a\u7a7a\u7684\u95ee\u9898"
].join("\n");
const updateLog = process.env.UPDATE_LOG || defaultUpdateLog;
const oldSort = ".sort((a, b) => a.id - b.id);";
const timeSort = ".sort((a, b) => (b.ctime - a.ctime) || (b.id - a.id));";
const newSort = ".sort((a, b) => b.id - a.id);";

if (!serverSource.includes(oldSort) && !serverSource.includes(timeSort) && !serverSource.includes(newSort)) {
  throw new Error("announcement sort expression not found; refusing to patch server.js");
}

fs.copyFileSync(configPath, `${configPath}.bak-${stamp}`);
fs.copyFileSync(serverPath, `${serverPath}.bak-${stamp}`);

config.latestVersion = {
  ...(config.latestVersion || {}),
  version_name: versionName,
  version_code: versionCode,
  update_log: updateLog,
  ctime: now,
  can_download: 1,
  is_release: 1
};
config.downloadUrls = config.downloadUrls || {};
config.downloadUrls[String(versionCode)] = apkUrl;

const title = process.env.ANNOUNCEMENT_TITLE ||
  `\u590d\u6d3b\u7248 ${versionName} \u6b63\u5f0f\u53d1\u5e03`;
const announcements = Array.isArray(config.announcements) ? config.announcements : [];
const maxId = announcements.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0);
config.announcements = announcements.filter((item) => item.title !== title);
config.announcements.push({
  id: maxId + 1,
  ctime: now,
  title,
  content: `${versionName} / ${versionCode}\n\n${updateLog}`
});

config.updateManifest = config.updateManifest || {};
config.updateManifest.payload = {
  ...(config.updateManifest.payload || {}),
  version_name: versionName,
  version_code: versionCode,
  full: {
    ...((config.updateManifest.payload && config.updateManifest.payload.full) || {}),
    url: apkUrl,
    sha256: apkSha256.toLowerCase(),
    size: apkSize
  },
  patches: []
};

const configTmp = `${configPath}.tmp-${process.pid}`;
const serverTmp = `${serverPath}.tmp-${process.pid}`;
fs.writeFileSync(configTmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
fs.writeFileSync(serverTmp, serverSource.replace(oldSort, newSort).replace(timeSort, newSort), { mode: 0o644 });
JSON.parse(fs.readFileSync(configTmp, "utf8"));
fs.renameSync(configTmp, configPath);
fs.renameSync(serverTmp, serverPath);
fs.chownSync(configPath, configStat.uid, configStat.gid);
fs.chmodSync(configPath, configStat.mode);
fs.chownSync(serverPath, serverStat.uid, serverStat.gid);
fs.chmodSync(serverPath, serverStat.mode);

console.log(JSON.stringify({ versionName, versionCode, announcementId: maxId + 1, apkUrl, apkSha256, apkSize }));
