"use strict";

const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
const { attachBrowserTunnel } = require("./browser-tunnel");

const ROOT = __dirname;
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(ROOT, "data", "config.json");
const LOG_DIR = process.env.LOG_DIR || path.join(ROOT, "logs");
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(ROOT, "public");
const DEFAULT_PORT = Number(process.env.PORT || 3000);
const MAX_BODY_BYTES = 256 * 1024;
const MAX_MULTIPART_BODY_BYTES = 20 * 1024 * 1024;
const RATE_WINDOW_MS = 60 * 1000;
const rateBuckets = new Map();
let lastRateCleanup = 0;
let stackLogSequence = null;
let stackWriteQueue = Promise.resolve();
let diagnosticWriteQueue = Promise.resolve();
let lastDiagnosticCleanupDay = "";
let cachedConfig = null;
let cachedConfigMtimeMs = -1;

const STATIC_MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".apk": "application/vnd.android.package-archive"
};

const DEFAULT_CONFIG = {
  port: DEFAULT_PORT,
  latestVersion: {
    version_name: "2.9.5-fix",
    version_code: 20260125,
    update_log: "Compatibility server is online.",
    ctime: 1769270400,
    can_download: 0,
    is_release: 1
  },
  latestBetaVersion: null,
  downloadUrls: {},
  announcements: [],
  sponsors: [],
  sponsorPageSize: 20,
  uploadStack: {
    enabled: true
  },
  uploadDiagnostics: {
    enabled: true,
    retentionDays: 30
  },
  hotConfig: {
    enabled: false,
    privateKeyPath: "",
    ttlSeconds: 86400,
    payload: {}
  },
  updateManifest: {
    enabled: false,
    privateKeyPath: "",
    payload: {}
  },
  compat: {
    enabled: false,
    basePath: "/compat/v1/bili",
    token: "",
    timeoutMs: 20000,
    routes: {}
  },
  relay: {
    enabled: false,
    basePath: "/bili-relay",
    token: "",
    timeoutMs: 20000,
    allowedHosts: [
      "bilibili.com",
      "*.bilibili.com",
      "*.bilivideo.com",
      "*.bilivideo.cn",
      "upos-*.akamaized.net",
      "*.hdslb.com",
      "*.biliapi.net",
      "api.bilibili.com",
      "api.vc.bilibili.com",
      "api.live.bilibili.com",
      "passport.bilibili.com",
      "account.bilibili.com",
      "member.bilibili.com",
      "www.bilibili.com",
      "live.bilibili.com",
      "space.bilibili.com",
      "search.bilibili.com",
      "s.search.bilibili.com",
      "comment.bilibili.com",
      "i0.hdslb.com",
      "i1.hdslb.com",
      "i2.hdslb.com",
      "b23.tv"
    ]
  }
};

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function mergeConfig(base, override) {
  return {
    ...base,
    ...override,
    latestVersion: {
      ...base.latestVersion,
      ...(override.latestVersion || {})
    },
    latestBetaVersion: override.latestBetaVersion || base.latestBetaVersion,
    downloadUrls: {
      ...base.downloadUrls,
      ...(override.downloadUrls || {})
    },
    uploadStack: {
      ...base.uploadStack,
      ...(override.uploadStack || {})
    },
    uploadDiagnostics: {
      ...base.uploadDiagnostics,
      ...(override.uploadDiagnostics || {})
    },
    hotConfig: {
      ...base.hotConfig,
      ...(override.hotConfig || {}),
      payload: {
        ...base.hotConfig.payload,
        ...((override.hotConfig && override.hotConfig.payload) || {})
      }
    },
    updateManifest: {
      ...base.updateManifest,
      ...(override.updateManifest || {}),
      payload: {
        ...base.updateManifest.payload,
        ...((override.updateManifest && override.updateManifest.payload) || {})
      }
    },
    compat: {
      ...base.compat,
      ...(override.compat || {}),
      routes: {
        ...base.compat.routes,
        ...((override.compat && override.compat.routes) || {})
      }
    },
    relay: {
      ...base.relay,
      ...(override.relay || {})
    }
  };
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return DEFAULT_CONFIG;
  }
  const mtimeMs = fs.statSync(CONFIG_PATH).mtimeMs;
  if (cachedConfig && cachedConfigMtimeMs === mtimeMs) return cachedConfig;
  cachedConfig = mergeConfig(DEFAULT_CONFIG, readJsonFile(CONFIG_PATH));
  cachedConfigMtimeMs = mtimeMs;
  return cachedConfig;
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, App-Info, Device-Info, User-Agent, X-Compat-Token, X-Relay-Token, X-Relay-Target-Scheme, X-Relay-Target-Host"
  });
  res.end(body);
}

function clientAddress(req) {
  const forwardedParts = String(req.headers["x-forwarded-for"] || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const forwarded = forwardedParts.length ? forwardedParts[forwardedParts.length - 1] : "";
  return forwarded || req.socket.remoteAddress || "unknown";
}

function allowRequest(req, bucketName, limit) {
  const now = Date.now();
  if (now - lastRateCleanup > RATE_WINDOW_MS) {
    for (const [key, bucket] of rateBuckets) {
      if (now - bucket.startedAt >= RATE_WINDOW_MS) rateBuckets.delete(key);
    }
    lastRateCleanup = now;
  }

  const key = `${bucketName}:${clientAddress(req)}`;
  let bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.startedAt >= RATE_WINDOW_MS) {
    bucket = { startedAt: now, count: 0 };
    rateBuckets.set(key, bucket);
  }
  bucket.count += 1;
  return bucket.count <= limit;
}

function resolveConfiguredPath(configuredPath) {
  if (!configuredPath) return "";
  return path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(ROOT, configuredPath);
}

function createSignedEnvelope(payload, privateKeyPath) {
  const resolvedKeyPath = resolveConfiguredPath(privateKeyPath);
  if (!resolvedKeyPath || !fs.existsSync(resolvedKeyPath)) {
    throw Object.assign(new Error("signing key is not configured"), { statusCode: 503 });
  }
  const payloadText = JSON.stringify(payload);
  const payloadBase64 = Buffer.from(payloadText, "utf8").toString("base64");
  const signature = crypto.sign(
    "RSA-SHA256",
    Buffer.from(payloadBase64, "ascii"),
    fs.readFileSync(resolvedKeyPath, "utf8")
  ).toString("base64");
  return {
    algorithm: "SHA256withRSA",
    payload: payloadBase64,
    signature
  };
}

function sendFile(res, req, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const fileSize = fs.statSync(filePath).size;
  const headers = {
    "Content-Type": STATIC_MIME_TYPES[ext] || "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=3600"
  };

  let start = 0;
  let end = fileSize - 1;
  let statusCode = 200;
  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) {
      res.writeHead(416, { ...headers, "Content-Range": `bytes */${fileSize}` });
      res.end();
      return;
    }
    if (match[1]) start = Number.parseInt(match[1], 10);
    if (match[2]) end = Number.parseInt(match[2], 10);
    if (!match[1] && match[2]) {
      const suffixLength = Number.parseInt(match[2], 10);
      start = Math.max(0, fileSize - suffixLength);
      end = fileSize - 1;
    }
    if (start < 0 || end < start || start >= fileSize) {
      res.writeHead(416, { ...headers, "Content-Range": `bytes */${fileSize}` });
      res.end();
      return;
    }
    end = Math.min(end, fileSize - 1);
    statusCode = 206;
    headers["Content-Range"] = `bytes ${start}-${end}/${fileSize}`;
  }

  headers["Content-Length"] = end - start + 1;
  res.writeHead(statusCode, headers);
  if (req.method === "HEAD") {
    res.end();
    return;
  }

  const stream = fs.createReadStream(filePath, { start, end });
  stream.on("error", (error) => {
    console.error("Static file stream failed:", error);
    if (!res.headersSent) {
      sendJson(res, 500, { code: 500, msg: "file read failed" });
    } else {
      res.destroy(error);
    }
  });
  stream.pipe(res);
}

function tryServePublic(req, res, url) {
  if (!["GET", "HEAD"].includes(req.method)) return false;

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch (error) {
    sendJson(res, 400, { code: 400, msg: "invalid path" });
    return true;
  }

  if (pathname === "/") pathname = "/index.html";
  const rootFiles = [
    "/index.html",
    "/robots.txt",
    "/sitemap.xml",
    "/llms.txt",
    "/site.webmanifest",
    "/b85000b1e838392eedf2889b11276d06.txt"
  ];
  if (!rootFiles.includes(pathname) && !pathname.startsWith("/assets/") && !pathname.startsWith("/download/")) return false;

  const root = path.resolve(PUBLIC_DIR);
  const filePath = path.resolve(path.join(root, pathname));
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
    sendJson(res, 403, { code: 403, msg: "forbidden" });
    return true;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;

  sendFile(res, req, filePath);
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("request body too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function readBodyBuffer(req) {
  return new Promise((resolve, reject) => {
    const contentType = String(req.headers["content-type"] || "").toLowerCase();
    const bodyLimit = contentType.startsWith("multipart/")
      ? MAX_MULTIPART_BODY_BYTES
      : MAX_BODY_BYTES;
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > bodyLimit) {
        reject(Object.assign(new Error("request body too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function asInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeAnnouncement(item) {
  return {
    id: Number(item.id || 0),
    ctime: Number(item.ctime || Math.floor(Date.now() / 1000)),
    title: String(item.title || ""),
    content: String(item.content || "")
  };
}

function normalizeSponsor(item) {
  return {
    name: String(item.name || ""),
    avatar: String(item.avatar || ""),
    sum_amount: Number(item.sum_amount || 0),
    last_time: Number(item.last_time || Math.floor(Date.now() / 1000))
  };
}

function safeHeaders(headers) {
  const copy = { ...headers };
  delete copy.authorization;
  delete copy.cookie;
  delete copy["set-cookie"];
  return copy;
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

function isRelayPath(config, url) {
  const basePath = (config.relay && config.relay.basePath) || "/bili-relay";
  return url.pathname === basePath || url.pathname.startsWith(`${basePath}/`);
}

function matchAllowedHost(host, allowedHosts) {
  const cleanHost = String(host || "").toLowerCase();
  return (allowedHosts || []).some((entry) => {
    const rule = String(entry || "").toLowerCase();
    if (rule.startsWith("upos-*.")) {
      const suffix = rule.slice("upos-*".length);
      return cleanHost.startsWith("upos-")
        && cleanHost.endsWith(suffix)
        && cleanHost.length > suffix.length + "upos-".length;
    }
    if (rule.startsWith("*.")) {
      const suffix = rule.slice(1);
      return cleanHost.endsWith(suffix) && cleanHost.length > suffix.length;
    }
    return cleanHost === rule;
  });
}

function parseRelayTarget(config, url, req) {
  const basePath = (config.relay && config.relay.basePath) || "/bili-relay";
  let rest = url.pathname.slice(basePath.length);
  if (rest.startsWith("/")) rest = rest.slice(1);

  const slashIndex = rest.indexOf("/");
  if (slashIndex < 1) {
    throw Object.assign(new Error("missing relay target host"), { statusCode: 400 });
  }

  const targetHost = decodeURIComponent(rest.slice(0, slashIndex)).toLowerCase();
  const targetPath = rest.slice(slashIndex) || "/";
  const requestedScheme = String(req.headers["x-relay-target-scheme"] || "https").toLowerCase();
  const scheme = requestedScheme === "http" ? "http" : "https";

  if (!/^[a-z0-9.-]+(?::\d+)?$/.test(targetHost)) {
    throw Object.assign(new Error("invalid relay target host"), { statusCode: 400 });
  }
  if (!matchAllowedHost(targetHost.replace(/:\d+$/, ""), config.relay.allowedHosts)) {
    throw Object.assign(new Error(`relay target not allowed: ${targetHost}`), { statusCode: 403 });
  }

  return new URL(`${scheme}://${targetHost}${targetPath}${url.search}`);
}

function relayRequestHeaders(headers, targetUrl, bodyLength) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (lower === "host" || lower === "content-length" || lower === "accept-encoding") continue;
    if (lower.startsWith("x-relay-") || lower.startsWith("x-compat-")) continue;
    out[key] = value;
  }
  out.Host = targetUrl.host;
  if (bodyLength !== undefined && bodyLength !== null) {
    // The request body is buffered before proxying.  Keep multipart uploads
    // on a fixed-length request because some upstream gateways reject chunked
    // multipart bodies and return an HTML error page instead of JSON.
    out["Content-Length"] = bodyLength;
    delete out["Transfer-Encoding"];
  }
  return out;
}

function relayResponseHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    out[key] = value;
  }
  return out;
}

function routeRelay(req, res, config, url) {
  if (!config.relay || config.relay.enabled !== true) {
    sendJson(res, 403, { code: 403, msg: "relay disabled" });
    return;
  }
  if (!["GET", "POST", "HEAD"].includes(req.method)) {
    sendJson(res, 405, { code: 405, msg: "method not allowed" });
    return;
  }
  if (config.relay.token && req.headers["x-relay-token"] !== config.relay.token) {
    sendJson(res, 401, { code: 401, msg: "invalid relay token" });
    return;
  }

  const targetUrl = parseRelayTarget(config, url, req);
  const client = targetUrl.protocol === "http:" ? http : https;
  const bodyPromise = req.method === "POST" ? readBodyBuffer(req) : Promise.resolve(null);
  bodyPromise.then((body) => {
    const options = {
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port || undefined,
      method: req.method,
      path: `${targetUrl.pathname}${targetUrl.search}`,
      headers: relayRequestHeaders(req.headers, targetUrl, body && body.length),
      timeout: Number(config.relay.timeoutMs || 20000)
    };

    const upstream = client.request(options, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, relayResponseHeaders(upstreamRes.headers));
      upstreamRes.pipe(res);
    });

    upstream.on("timeout", () => {
      upstream.destroy(Object.assign(new Error("upstream timeout"), { statusCode: 504 }));
    });
    upstream.on("error", (error) => {
      if (!res.headersSent) {
        sendJson(res, error.statusCode || 502, {
          code: error.statusCode || 502,
          msg: error.message || "relay upstream error"
        });
      } else {
        res.destroy(error);
      }
    });

    upstream.end(body || undefined);
  }).catch((error) => {
    if (!res.headersSent) {
      sendJson(res, error.statusCode || 400, {
        code: error.statusCode || 400,
        msg: error.message || "invalid relay request body"
      });
    } else {
      res.destroy(error);
    }
  });
}

function routeHotConfig(req, res, config) {
  if (!config.hotConfig || config.hotConfig.enabled !== true) {
    sendJson(res, 404, { code: 404, msg: "hot config disabled" });
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  const ttlSeconds = Math.max(asInt(config.hotConfig.ttlSeconds, 86400), 300);
  const payload = {
    schema: 1,
    issued_at: now,
    expires_at: now + ttlSeconds,
    ...config.hotConfig.payload
  };
  sendJson(res, 200, {
    code: 0,
    msg: "success",
    data: createSignedEnvelope(payload, config.hotConfig.privateKeyPath)
  });
}

function routeUpdateManifest(req, res, config) {
  if (!config.updateManifest || config.updateManifest.enabled !== true) {
    sendJson(res, 404, { code: 404, msg: "update manifest disabled" });
    return;
  }
  const payload = {
    schema: 1,
    generated_at: Math.floor(Date.now() / 1000),
    ...config.updateManifest.payload
  };
  sendJson(res, 200, {
    code: 0,
    msg: "success",
    data: createSignedEnvelope(
      payload,
      config.updateManifest.privateKeyPath || (config.hotConfig && config.hotConfig.privateKeyPath)
    )
  });
}

function isCompatPath(config, url) {
  const basePath = (config.compat && config.compat.basePath) || "/compat/v1/bili";
  return url.pathname.startsWith(`${basePath}/`);
}

function parseCompatTarget(config, url, req) {
  if (!config.compat || config.compat.enabled !== true) {
    throw Object.assign(new Error("compat routes disabled"), { statusCode: 403 });
  }
  const basePath = config.compat.basePath || "/compat/v1/bili";
  const routeId = decodeURIComponent(url.pathname.slice(basePath.length + 1));
  if (!/^[a-z0-9_-]{1,64}$/i.test(routeId)) {
    throw Object.assign(new Error("invalid compat route"), { statusCode: 400 });
  }
  const route = config.compat.routes && config.compat.routes[routeId];
  if (!route || !route.upstream) {
    throw Object.assign(new Error("unknown compat route"), { statusCode: 404 });
  }
  const method = String(route.method || "GET").toUpperCase();
  if (req.method !== method) {
    throw Object.assign(new Error("method not allowed"), { statusCode: 405 });
  }
  const targetUrl = new URL(route.upstream);
  if (!matchAllowedHost(targetUrl.hostname, config.relay && config.relay.allowedHosts)) {
    throw Object.assign(new Error("compat upstream not allowed"), { statusCode: 403 });
  }
  for (const [key, value] of url.searchParams.entries()) {
    targetUrl.searchParams.append(key, value);
  }
  return targetUrl;
}

function routeCompat(req, res, config, url) {
  const token = config.compat && config.compat.token;
  if (token && req.headers["x-compat-token"] !== token) {
    sendJson(res, 401, { code: 401, msg: "invalid compat token" });
    return;
  }

  const targetUrl = parseCompatTarget(config, url, req);
  const client = targetUrl.protocol === "http:" ? http : https;
  const bodyPromise = req.method === "POST" ? readBodyBuffer(req) : Promise.resolve(null);
  bodyPromise.then((body) => {
    const options = {
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port || undefined,
      method: req.method,
      path: `${targetUrl.pathname}${targetUrl.search}`,
      headers: relayRequestHeaders(req.headers, targetUrl, body && body.length),
      timeout: Number(config.compat.timeoutMs || 20000)
    };
    const upstream = client.request(options, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, relayResponseHeaders(upstreamRes.headers));
      upstreamRes.pipe(res);
    });
    upstream.on("timeout", () => {
      upstream.destroy(Object.assign(new Error("compat upstream timeout"), { statusCode: 504 }));
    });
    upstream.on("error", (error) => {
      if (!res.headersSent) {
        sendJson(res, error.statusCode || 502, {
          code: error.statusCode || 502,
          msg: error.message || "compat upstream error"
        });
      } else {
        res.destroy(error);
      }
    });
    upstream.end(body || undefined);
  }).catch((error) => {
    if (!res.headersSent) {
      sendJson(res, error.statusCode || 400, {
        code: error.statusCode || 400,
        msg: error.message || "invalid compat request body"
      });
    } else {
      res.destroy(error);
    }
  });
}

function initializeStackLogSequence(filePath) {
  if (stackLogSequence !== null) return;
  if (!fs.existsSync(filePath)) {
    stackLogSequence = 0;
    return;
  }
  const content = fs.readFileSync(filePath, "utf8");
  stackLogSequence = content.split("\n").reduce((count, line) => count + (line ? 1 : 0), 0);
}

async function appendStackLog(entry) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const filePath = path.join(LOG_DIR, "stacks.ndjson");
  initializeStackLogSequence(filePath);
  const id = ++stackLogSequence;
  const line = `${JSON.stringify({ id, ...entry })}\n`;
  stackWriteQueue = stackWriteQueue
    .catch(() => {})
    .then(() => fs.promises.appendFile(filePath, line, "utf8"));
  await stackWriteQueue;
  return id;
}

function sanitizeDiagnosticDetails(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, 20)) {
    if (!/^[a-zA-Z0-9_.-]{1,48}$/.test(key)) continue;
    if (typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) {
      result[key] = item;
    } else if (typeof item === "string") {
      result[key] = item.slice(0, 120);
    }
  }
  return result;
}

function normalizeDiagnosticEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const name = String(value.name || "");
  if (!/^[a-z0-9_.-]{1,48}$/.test(name)) return null;
  const time = Number(value.time);
  return {
    time: Number.isFinite(time) && time > 0 ? Math.floor(time) : Date.now(),
    name,
    details: sanitizeDiagnosticDetails(value.details)
  };
}

function selectJsonHeader(value, allowedKeys) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result = {};
    for (const key of allowedKeys) {
      const item = parsed[key];
      if (typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) {
        result[key] = item;
      } else if (typeof item === "string") {
        result[key] = item.slice(0, 120);
      }
    }
    return result;
  } catch (error) {
    return {};
  }
}

async function appendDiagnosticEvents(req, installId, events) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const filePath = path.join(LOG_DIR, `diagnostics-${day}.ndjson`);
  const receivedAt = new Date().toISOString();
  const appInfo = selectJsonHeader(req.headers["app-info"], [
    "versionName", "versionCode", "isBeta", "applicationId", "buildType", "debugEnabled"
  ]);
  const deviceInfo = selectJsonHeader(req.headers["device-info"], [
    "sdk", "release", "product", "brand", "device", "type", "id"
  ]);
  const lines = events.map((event) => `${JSON.stringify({
    received_at: receivedAt,
    install_id: installId,
    app_info: appInfo,
    device_info: deviceInfo,
    event
  })}\n`).join("");
  diagnosticWriteQueue = diagnosticWriteQueue
    .catch(() => {})
    .then(() => fs.promises.appendFile(filePath, lines, "utf8"));
  await diagnosticWriteQueue;
}

function cleanupDiagnosticLogs(retentionDays) {
  const day = new Date().toISOString().slice(0, 10);
  if (lastDiagnosticCleanupDay === day) return;
  lastDiagnosticCleanupDay = day;
  const keepDays = Math.max(1, Math.min(asInt(retentionDays, 30), 365));
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  if (!fs.existsSync(LOG_DIR)) return;
  for (const name of fs.readdirSync(LOG_DIR)) {
    const match = /^diagnostics-(\d{4}-\d{2}-\d{2})\.ndjson$/.exec(name);
    if (!match) continue;
    const timestamp = Date.parse(`${match[1]}T00:00:00Z`);
    if (Number.isFinite(timestamp) && timestamp < cutoff) {
      fs.unlinkSync(path.join(LOG_DIR, name));
    }
  }
}

function routeGetLast(req, res, config, url) {
  const betaRequested = url.searchParams.get("channel") === "beta";
  const version = betaRequested && config.latestBetaVersion
    ? config.latestBetaVersion
    : config.latestVersion;
  sendJson(res, 200, {
    code: 0,
    msg: "success",
    data: version
  });
}

function routeGetDownloadUrl(req, res, config, url) {
  const versionCode = url.searchParams.get("version_code");
  const downloadUrl = config.downloadUrls[String(versionCode)] || "";

  if (!downloadUrl) {
    sendJson(res, 200, {
      code: 404,
      msg: `download url not found for version_code=${versionCode || ""}`,
      data: ""
    });
    return;
  }

  sendJson(res, 200, {
    code: 0,
    msg: "success",
    data: downloadUrl
  });
}

function routeAnnouncements(req, res, config, url) {
  const from = asInt(url.searchParams.get("from"), null);
  const list = (config.announcements || [])
    .map(normalizeAnnouncement)
    .filter((item) => from === null || item.id > from)
    .sort((a, b) => b.id - a.id);

  sendJson(res, 200, {
    code: 0,
    msg: "success",
    data: list
  });
}

async function routeUploadStack(req, res, config) {
  if (!config.uploadStack || config.uploadStack.enabled === false) {
    sendJson(res, 200, {
      code: 503,
      msg: "stack upload disabled",
      id: -1
    });
    return;
  }

  let parsed = {};
  const rawBody = await readBody(req);
  if (rawBody.trim()) {
    try {
      parsed = JSON.parse(rawBody);
    } catch (error) {
      sendJson(res, 200, {
        code: 400,
        msg: "invalid json body",
        id: -1
      });
      return;
    }
  }

  const id = await appendStackLog({
    received_at: new Date().toISOString(),
    remote_addr: req.socket.remoteAddress,
    headers: safeHeaders(req.headers),
    body: parsed
  });

  sendJson(res, 200, {
    code: 200,
    msg: "",
    id
  });
}

async function routeUploadDiagnostics(req, res, config) {
  if (!config.uploadDiagnostics || config.uploadDiagnostics.enabled === false) {
    sendJson(res, 200, { code: 503, msg: "diagnostic upload disabled", accepted: 0 });
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(await readBody(req));
  } catch (error) {
    sendJson(res, 200, { code: 400, msg: "invalid json body", accepted: 0 });
    return;
  }

  const installId = String(parsed.install_id || "");
  if (!/^[a-zA-Z0-9-]{16,64}$/.test(installId) || !Array.isArray(parsed.events)) {
    sendJson(res, 200, { code: 400, msg: "invalid diagnostic payload", accepted: 0 });
    return;
  }

  const events = parsed.events.slice(0, 50).map(normalizeDiagnosticEvent).filter(Boolean);
  if (events.length === 0) {
    sendJson(res, 200, { code: 400, msg: "no valid events", accepted: 0 });
    return;
  }

  cleanupDiagnosticLogs(config.uploadDiagnostics.retentionDays);
  await appendDiagnosticEvents(req, installId, events);
  sendJson(res, 200, { code: 200, msg: "", accepted: events.length });
}

function routeSponsors(req, res, config, url) {
  const page = Math.max(asInt(url.searchParams.get("page"), 1), 1);
  const pageSize = Math.max(asInt(config.sponsorPageSize, 20), 1);
  const start = (page - 1) * pageSize;
  const data = (config.sponsors || [])
    .slice(start, start + pageSize)
    .map(normalizeSponsor);

  sendJson(res, 200, {
    code: 200,
    msg: "success",
    data
  });
}

async function handleRequest(req, res) {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    sendJson(res, 500, {
      code: 500,
      msg: `config error: ${error.message}`
    });
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const route = `${req.method} ${url.pathname}`;

  const isProxyRequest = url.pathname.startsWith("/bili-relay/")
    || url.pathname.startsWith("/compat/v1/bili/");
  const isDiagnosticUpload = route === "POST /terminal/upload/diagnostics";
  const rateLimit = route === "POST /terminal/upload/stack" ? 12
    : (isDiagnosticUpload ? 600 : (isProxyRequest ? 600 : 180));
  const bucketName = route === "POST /terminal/upload/stack" ? "stack"
    : (isDiagnosticUpload ? "diagnostics" : (isProxyRequest ? "proxy" : "api"));
  if (!allowRequest(req, bucketName, rateLimit)) {
    res.setHeader("Retry-After", "60");
    sendJson(res, 429, { code: 429, msg: "too many requests" });
    return;
  }

  try {
    if (tryServePublic(req, res, url)) {
      return;
    }

    if (route === "GET /healthz") {
      sendJson(res, 200, { ok: true });
    } else if (route === "GET /terminal/config/get") {
      routeHotConfig(req, res, config);
    } else if (route === "GET /terminal/update/manifest") {
      routeUpdateManifest(req, res, config);
    } else if (isCompatPath(config, url)) {
      routeCompat(req, res, config, url);
    } else if (isRelayPath(config, url)) {
      routeRelay(req, res, config, url);
    } else if (route === "GET /terminal/version/get_last") {
      routeGetLast(req, res, config, url);
    } else if (route === "GET /terminal/version/get_download_url") {
      routeGetDownloadUrl(req, res, config, url);
    } else if (route === "GET /terminal/announcement/get_list") {
      routeAnnouncements(req, res, config, url);
    } else if (route === "POST /terminal/upload/stack") {
      await routeUploadStack(req, res, config);
    } else if (route === "POST /terminal/upload/diagnostics") {
      await routeUploadDiagnostics(req, res, config);
    } else if (route === "GET /terminal/afdian/get_sponsor") {
      routeSponsors(req, res, config, url);
    } else {
      sendJson(res, 404, {
        code: 404,
        msg: "not found"
      });
    }
  } catch (error) {
    sendJson(res, error.statusCode || 500, {
      code: error.statusCode || 500,
      msg: error.message || "internal server error"
    });
  }
}

const config = loadConfig();
const port = Number(process.env.PORT || config.port || DEFAULT_PORT);
const host = process.env.HOST || "127.0.0.1";

const server = http.createServer(handleRequest);
attachBrowserTunnel(server, loadConfig);
server.listen(port, host, () => {
  console.log(`BiliTerminal compatibility server listening on http://${host}:${port}`);
  console.log(`Config: ${CONFIG_PATH}`);
});
