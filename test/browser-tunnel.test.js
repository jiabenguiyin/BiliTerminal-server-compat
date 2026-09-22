"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const { once } = require("node:events");
const WebSocket = require("ws");
const { attachBrowserTunnel, isPublicAddress, parseTarget, resolveTarget, tokenMatches } = require("../browser-tunnel");

test("reject private, reserved and mapped private IP addresses", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.2", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fc00::1",
    "fe80::1", "::ffff:127.0.0.1", "2001:db8::1", "not-an-ip"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress("1.1.1.1"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
});

test("only valid web ports and hosts are accepted", () => {
  assert.deepEqual(parseTarget(new URL("http://local/browser-tunnel?host=example.com&port=443")),
    { host: "example.com", port: 443 });
  for (const query of ["host=localhost&port=80", "host=example.com&port=22", "host=a.local&port=443",
    "host=a%40b&port=80", "host=example.com.&port=80", "host=a%0d%0a&port=443"]) {
    assert.throws(() => parseTarget(new URL("http://local/?" + query)));
  }
});

test("DNS answers are validated and pinned, including mixed and mapped answers", async () => {
  await assert.rejects(resolveTarget("example.com", async () => [{ address: "10.0.0.2", family: 4 }]));
  await assert.rejects(resolveTarget("example.com", async () =>
    [{ address: "1.1.1.1", family: 4 }, { address: "::ffff:192.168.0.2", family: 6 }]));
  let calls = 0;
  const result = await resolveTarget("example.com", async () => {
    calls++;
    return [{ address: "1.1.1.1", family: 4 }];
  });
  assert.deepEqual(result, { address: "1.1.1.1", family: 4 });
  assert.equal(calls, 1);
});

test("token required and compared exactly", () => {
  const token = "test-token-not-a-production-secret";
  assert.equal(tokenMatches(token, token), true);
  assert.equal(tokenMatches("", ""), false);
  assert.equal(tokenMatches(undefined, token), false);
  assert.equal(tokenMatches(token + "x", token), false);
});

async function fixture(t, enabled = true, onConnection = socket => socket.pipe(socket)) {
  const upstream = net.createServer(onConnection);
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const server = http.createServer((req, res) => { res.writeHead(404).end(); });
  const token = "test-token-not-a-production-secret";
  const targets = [];
  const wss = attachBrowserTunnel(server, () => ({
    relay: { enabled: true, token }, browserRelay: { enabled }
  }), {
    lookup: async host => [{ address: host === "private.test" ? "127.0.0.1" : "1.1.1.1", family: 4 }],
    connect: options => {
      targets.push(options);
      return net.connect({ host: "127.0.0.1", port: upstream.address().port });
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    server.close();
    upstream.close();
  });
  return { url: `ws://127.0.0.1:${server.address().port}/browser-tunnel`, token, targets };
}

async function rejection(url, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.on("unexpected-response", (req, res) => {
      res.resume();
      resolve(res.statusCode);
      ws.terminate();
    });
    ws.on("error", () => {});
    ws.on("open", () => { ws.terminate(); reject(new Error("Unexpected connection")); });
  });
}

test("authentication, Origin, private targets and default-off are enforced", async t => {
  const f = await fixture(t);
  assert.equal(await rejection(f.url + "?host=example.com&port=443", {}), 403);
  assert.equal(await rejection(f.url + "?host=example.com&port=443",
    { "X-Relay-Token": f.token, Origin: "https://example.com" }), 403);
  assert.equal(await rejection(f.url + "?host=private.test&port=443", { "X-Relay-Token": f.token }), 403);
  assert.equal(f.targets.length, 0);
  const disabled = await fixture(t, false);
  assert.equal(await rejection(disabled.url + "?host=example.com&port=443",
    { "X-Relay-Token": disabled.token }), 503);
});

test("authenticated binary tunnel preserves POST bodies, TLS bytes and large data", async t => {
  const f = await fixture(t);
  const ws = new WebSocket(f.url + "?host=example.com&port=443", { headers: { "X-Relay-Token": f.token } });
  await once(ws, "open");
  const data = Buffer.alloc(512 * 1024);
  for (let i = 0; i < data.length; i++) data[i] = i % 256;
  const received = [];
  let length = 0;
  const done = new Promise(resolve => ws.on("message", value => {
    received.push(value);
    length += value.length;
    if (length === data.length) resolve();
  }));
  for (let i = 0; i < data.length; i += 16384) ws.send(data.subarray(i, i + 16384));
  await done;
  assert.deepEqual(Buffer.concat(received), data);
  assert.deepEqual(f.targets, [{ host: "1.1.1.1", family: 4, port: 443 }]);
  ws.close();
  await once(ws, "close");
});

test("upstream close delivers the complete final response before closing WebSocket", async t => {
  const data = Buffer.alloc(1024 * 1024, 65);
  const f = await fixture(t, true, socket => socket.once("data", () => socket.end(data)));
  const ws = new WebSocket(f.url + "?host=example.com&port=80", { headers: { "X-Relay-Token": f.token } });
  const received = [];
  ws.on("message", value => received.push(value));
  await once(ws, "open");
  ws.send(Buffer.from("GET / HTTP/1.1\r\nHost: example.com\r\n\r\n"));
  await once(ws, "close");
  assert.deepEqual(Buffer.concat(received), data);
});
