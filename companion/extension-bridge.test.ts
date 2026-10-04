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
