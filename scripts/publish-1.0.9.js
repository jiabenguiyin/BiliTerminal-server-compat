"use strict";

const fs = require("fs");
const path = require("path");

const configPath = path.resolve(__dirname, "..", "data", "config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const now = Math.floor(Date.now() / 1000);

const release = {
  versionName: "1.0.9",
  versionCode: 2026072201,
  updateLog: "- 修复部分设备无法播放视频的问题。",
  apkUrl: "https://jp.031030.xyz/download/BiliTerminal-1.0.9-2026072201-release.apk",
  apkSha256: "5efed1befa35bc5e8da8289da0575ed402aa2da30cc4a02fe0b3d11d6e24b488",
  apkSize: 10086293
};

config.latestVersion = {
  version_name: release.versionName,
  version_code: release.versionCode,
  update_log: release.updateLog,
  ctime: now,
  can_download: 1,
  is_release: 1
};

config.downloadUrls = config.downloadUrls || {};
config.downloadUrls[String(release.versionCode)] = release.apkUrl;

if (!config.updateManifest || !config.updateManifest.payload) {
  throw new Error("updateManifest.payload is missing from data/config.json");
}
config.updateManifest.payload.version_name = release.versionName;
config.updateManifest.payload.version_code = release.versionCode;
config.updateManifest.payload.full = {
  url: release.apkUrl,
  sha256: release.apkSha256,
  size: release.apkSize
};
config.updateManifest.payload.patches = [];

config.announcements = config.announcements || [];
const announcementContent = `${release.versionName} / ${release.versionCode}\n\n${release.updateLog}`;
let announcement = config.announcements.find((item) =>
  item && String(item.content || "").startsWith(`${release.versionName} / ${release.versionCode}`));
if (!announcement) {
  const nextId = config.announcements.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1;
  announcement = { id: nextId };
  config.announcements.push(announcement);
}
announcement.ctime = now;
announcement.title = `复活版 ${release.versionName} 正式发布`;
announcement.content = announcementContent;

const tempPath = `${configPath}.tmp`;
fs.writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
fs.renameSync(tempPath, configPath);
console.log(`Published ${release.versionName} / ${release.versionCode} as announcement ${announcement.id}`);
