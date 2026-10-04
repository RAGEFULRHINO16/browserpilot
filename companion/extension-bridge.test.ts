import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { WebSocket } from "ws";
import { ExtensionBridge } from "./extension-bridge";

test("Brave bridge accepts only a paired extension origin and routes profile RPCs", async () => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const bridge = new ExtensionBridge("a".repeat(64), address.port);
  bridge.attach(server);
  const url = `ws://127.0.0.1:${address.port}/bridge`;
  const extensionOrigin = `chrome-extension://${"a".repeat(32)}`;
  let socket: WebSocket | undefined;
  try {
    const rejected = new WebSocket(url, { origin: "https://evil.example" });
    rejected.on("error", () => undefined);
    const [, response] = await once(rejected, "unexpected-response");
    response.destroy();
    assert.equal(bridge.connected(), false);

    socket = new WebSocket(url, { origin: extensionOrigin });
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "hello", token: "a".repeat(64), profileId: "default" }));
    await once(socket, "message");
    assert.equal(bridge.connected(), true);
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as { id?: number; command?: string };
      if (message.command === "echo") socket?.send(JSON.stringify({ id: message.id, result: { ok: true } }));
    });
    assert.deepEqual(await bridge.rpc("echo"), { ok: true });
  } finally {
    socket?.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function fixture(heartbeatIntervalMs = 15_000) {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const bridge = new ExtensionBridge("a".repeat(64), address.port, { heartbeatIntervalMs });
  bridge.attach(server);
  const sockets: WebSocket[] = [];
  return { bridge, async connect(autoPong = true) {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/bridge`, {
      origin: `chrome-extension://${"a".repeat(32)}`, autoPong,
    });
    sockets.push(socket);
    await once(socket, "open");
    const paired = once(socket, "message");
    socket.send(JSON.stringify({ type: "hello", token: "a".repeat(64), profileId: "default" }));
    await paired;
    return socket;
  }, async close() {
    for (const socket of sockets) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  } };
}

test("replacing a profile promptly rejects its old RPC without disconnecting the new peer", { timeout: 3000 }, async () => {
  const setup = await fixture();
  try {
    const old = await setup.connect();
    const received = once(old, "message");
    const pending = assert.rejects(setup.bridge.rpc("interact", {}, "default", 2000), /reconnected.*Inspect the page.*may have completed/);
    await received;
    const replacement = await setup.connect();
    await pending;
    assert.equal(setup.bridge.connected(), true);
    replacement.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      replacement.send(JSON.stringify({ id: message.id, result: "new-peer" }));
    });
    assert.equal(await setup.bridge.rpc("snapshot"), "new-peer");
  } finally { await setup.close(); }
});

test("RPC timeouts carry a bounded queue deadline and warn against blind mutation retries", async () => {
  const setup = await fixture();
  try {
    const socket = await setup.connect();
    const received = once(socket, "message");
    const started = Date.now();
    const pending = assert.rejects(setup.bridge.rpc("interact", {}, "default", 50), /timed out.*Inspect the page.*may have completed/);
    const [raw] = await received;
    const message = JSON.parse(raw.toString());
    assert.equal(message.command, "interact");
    assert.ok(message.deadlineAt >= started + 50 && message.deadlineAt <= Date.now() + 50);
    await pending;
    await assert.rejects(setup.bridge.rpc("interact", {}, "default", 60_001), /Invalid extension command timeout/);
  } finally { await setup.close(); }
});

test("heartbeat detects a silent extension while a responding peer remains connected", { timeout: 3000 }, async () => {
  const setup = await fixture(40);
  try {
    const silent = await setup.connect(false);
    const closed = once(silent, "close");
    const pending = assert.rejects(setup.bridge.rpc("snapshot", {}, "default", 2000), /unresponsive.*Inspect the page.*may have completed/);
    await pending;
    await closed;
    assert.equal(setup.bridge.connected(), false);
    assert.deepEqual(setup.bridge.profiles(), []);
    await setup.connect();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(setup.bridge.connected(), true);
  } finally { await setup.close(); }
});
