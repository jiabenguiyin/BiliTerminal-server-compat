"use strict";

const crypto = require("node:crypto");
const dns = require("node:dns").promises;
const net = require("node:net");
const ipaddr = require("ipaddr.js");
const { WebSocketServer, createWebSocketStream } = require("ws");

function isPublicAddress(address) {
  try {
    const parsed = ipaddr.process(address);
    return parsed.range() === "unicast";
  } catch {
    return false;
  }
}

function parseTarget(url) {
  const host = url.searchParams.get("host") || "";
  const port = Number(url.searchParams.get("port"));
  if (!host || host.length > 253 || /[^a-zA-Z0-9.:\-]/.test(host)
      || host.endsWith(".") || ![80, 443].includes(port)) {
    throw new Error("invalid target");
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new Error("local target");
  }
  return { host, port };
}

async function resolveTarget(host, lookup = dns.lookup) {
  const addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) }]
    : await lookup(host, { all: true, verbatim: true });
  // Reject mixed public/private answers too; connect only to this validated IP.
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) {
    throw new Error("non-public target");
  }
  return addresses.find(item => item.family === 4) || addresses[0];
}

function tokenMatches(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string" || expected.length < 24) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function attachBrowserTunnel(server, loadConfig, options = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  const clients = new Map();
  let active = 0;
  const lookup = options.lookup || dns.lookup;
  const connect = options.connect || net.connect;

  server.on("upgrade", async (req, socket, head) => {
    socket.on("error", () => {});
    const reject = code => {
      if (!socket.destroyed) socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    let url;
    try {
      url = new URL(req.url, "http://localhost");
      if (url.pathname !== "/browser-tunnel") return reject(404);
      const config = loadConfig();
      const relay = config.relay || {};
      const browser = config.browserRelay || {};
      if (!relay.enabled || !browser.enabled) return reject(503);
      // A website must never be able to open this privileged tunnel itself.
      if (req.headers.origin || !tokenMatches(req.headers["x-relay-token"], relay.token)) return reject(403);
      const target = parseTarget(url);
      const client = socket.remoteAddress || "unknown";
      if (active >= 64 || (clients.get(client) || 0) >= 24) return reject(429);
      active++;
      clients.set(client, (clients.get(client) || 0) + 1);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        active--;
        const count = (clients.get(client) || 1) - 1;
        if (count) clients.set(client, count);
        else clients.delete(client);
      };
      socket.once("close", release);
      const deadline = setTimeout(() => socket.destroy(), 15000);
      let upstream;
      let upgraded = false;
      try {
        const resolved = await resolveTarget(target.host, lookup);
        if (socket.destroyed) return;
        upstream = connect({ host: resolved.address, family: resolved.family, port: target.port });
        socket.once("close", () => upstream.destroy());
        upstream.on("error", () => socket.destroy());
        upstream.setTimeout(120000, () => upstream.destroy());
        upstream.once("connect", () => {
          clearTimeout(deadline);
          if (socket.destroyed) return upstream.destroy();
          wss.handleUpgrade(req, socket, head, ws => {
            upgraded = true;
            const stream = createWebSocketStream(ws, { highWaterMark: 64 * 1024 });
            const lifetime = setTimeout(() => ws.terminate(), 30 * 60 * 1000);
            ws.once("close", () => {
              clearTimeout(lifetime);
              upstream.destroy();
              stream.destroy();
              release();
            });
            ws.on("error", () => upstream.destroy());
            stream.on("error", () => upstream.destroy());
            upstream.on("error", () => stream.destroy());
            stream.on("close", () => {
              clearTimeout(lifetime);
              upstream.destroy();
              release();
            });
            ws.on("message", (data, binary) => {
              if (!binary) ws.close(1003, "binary required");
            });
            upstream.pipe(stream).pipe(upstream);
          });
        });
        upstream.once("close", () => {
          clearTimeout(deadline);
          if (!upgraded) socket.destroy();
        });
      } catch {
        clearTimeout(deadline);
        if (upstream) upstream.destroy();
        reject(403);
      }
    } catch {
      reject(400);
    }
  });
  return wss;
}

module.exports = { attachBrowserTunnel, isPublicAddress, parseTarget, resolveTarget, tokenMatches };
