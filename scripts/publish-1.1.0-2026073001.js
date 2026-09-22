"use strict";

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const configPath = path.join(root, "data", "config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const versionName = "1.1.0";
const versionCode = 2026073001;
const apkUrl = "https://jp.031030.xyz/download/BiliTerminal-1.1.0-2026073001-release.apk";
const sha256 = "820d78a44a995f2fbc511d1982853723747aeeeaff0aaf4cb13240c305e64ff1";
const size = 10098890;
const now = Math.floor(Date.now() / 1000);
const updateLog = [
  "- 新增手动上传诊断日志，上传前会再次确认",
  "- 修复部分华为手表的视频播放兼容问题",
  "- 改进 Cookie 与登录状态续期"
].join("\n");

config.latestVersion = {
  version_name: versionName,
  version_code: versionCode,
  update_log: updateLog,
  ctime: now,
  can_download: 1,
  is_release: 1
};
config.downloadUrls[String(versionCode)] = apkUrl;
config.updateManifest.payload.version_name = versionName;
config.updateManifest.payload.version_code = versionCode;
config.updateManifest.payload.full = { url: apkUrl, sha256, size };
config.updateManifest.payload.patches = [];
config.announcements = config.announcements.filter((item) => Number(item && item.id) !== 17);
config.announcements.push({
  id: 17,
  ctime: now,
  title: "复活版 1.1.0 热更新",
  content: `1.1.0 / ${versionCode}\n\n${updateLog}`
});

fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ versionName, versionCode, announcementId: 17, ctime: now }));
