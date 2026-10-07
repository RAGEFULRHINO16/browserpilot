import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";

async function fixture(prepare: (directory: string) => Promise<void>,
  check: (client: { directory: string; health(): Promise<any>; action(input: object): Promise<any>; connect(): Promise<WebSocket> }) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "browserpilot-reliability-"));
  const sockets: WebSocket[] = [];
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const token = randomBytes(32).toString("hex");
  const base = `http://127.0.0.1:${address.port}`;
  await prepare(directory);
  const child = spawn(process.execPath, ["--import", "tsx", "companion/server.ts"], {
    cwd: process.cwd(), windowsHide: true, stdio: "ignore",
    env: { ...process.env, BROWSERPILOT_COMPANION_TOKEN: token, BROWSERPILOT_COMPANION_PORT: String(address.port),
      BROWSERPILOT_BROWSER_BACKEND: "extension", BROWSERPILOT_DATA_DIR: directory,
      BROWSERPILOT_CONFIG_PATH: path.join(directory, "config.json"), BROWSERPILOT_PROFILE_DIR: path.join(directory, "profile"),
      BROWSERPILOT_DOWNLOAD_DIR: path.join(directory, "downloads"), BROWSERPILOT_UPLOAD_DIR: path.join(directory, "uploads") },
  });
  const health = async () => {
    const response = await fetch(`${base}/health`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.ok, true, "isolated companion health endpoint must respond successfully");
    return response.json();
  };
  try {
    let ready = false;
    const startupDeadline = Date.now() + 15_000;
    while (Date.now() < startupDeadline) {
      if (await health().catch(() => undefined)) { ready = true; break; }
      assert.equal(child.exitCode, null, "isolated companion must remain running");
      assert.equal(child.signalCode, null, "isolated companion must not be terminated during startup");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, "isolated companion must become healthy within 15 seconds");
    await check({ directory, health, async action(input) {
      const response = await fetch(`${base}/action`, { method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(input) });
      assert.equal(response.status, 200);
      return (await response.json()).result;
    }, async connect() {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/bridge`, { origin: `chrome-extension://${"a".repeat(32)}` });
      sockets.push(socket);
      await once(socket, "open");
      const paired = once(socket, "message");
      socket.send(JSON.stringify({ type: "hello", profileId: "default",
        token: createHmac("sha256", token).update("browserpilot-brave-extension-v1").digest("hex") }));
      await paired;
      return socket;
    } });
  } finally {
    for (const socket of sockets) socket.terminate();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("browserpilot-reliability-"));
    await rm(directory, { recursive: true, force: true });
  }
}

test("a corrupted workflow catalog does not stop ordinary companion or browser control", { timeout: 30_000 }, async () => {
  const corrupt = "{not-valid-json";
  await fixture(async (directory) => {
    await mkdir(path.join(directory, "Workflows"));
    await writeFile(path.join(directory, "Workflows", "workflows.json"), corrupt);
  }, async (client) => {
    const initial = await client.health();
    assert.equal(initial.serviceReady, true);
    assert.equal(initial.workflows.catalogReady, false);
    assert.match(initial.workflows.warnings[0], /preserved/);
    const socket = await client.connect();
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      socket.send(JSON.stringify({ id: message.id, result: { pageId: "page-1", url: "https://example.com", text: "Available" } }));
    });
    assert.equal((await client.health()).ready, true);
    assert.equal((await client.action({ type: "snapshot", pageId: "page-1" })).text, "Available");
    assert.equal((await client.action({ type: "workflow_status" })).persistence.catalogReady, false);
    assert.equal(await readFile(path.join(client.directory, "Workflows", "workflows.json"), "utf8"), corrupt);
  });
});

test("a stale recorded page ID fails closed and only explicit retries advance the retry counter", { timeout: 30_000 }, async () => {
  const id = "a".repeat(16);
  await fixture(async (directory) => {
    await mkdir(path.join(directory, "Workflows"));
    await writeFile(path.join(directory, "Workflows", "workflows.json"), JSON.stringify([
      { id, name: "Do not retarget", createdAt: new Date().toISOString(), steps: [{ type: "click", index: 0, pageId: "page-999" }] },
    ]));
  }, async (client) => {
    const socket = await client.connect();
    let staleChecks = 0;
    let mutations = 0;
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.command === "interact") mutations++;
      if (message.command === "dom" && message.args.pageId === "page-999") {
        staleChecks++;
        socket.send(JSON.stringify({ id: message.id, error: "Page ID is stale. List tabs and select the intended page again." }));
      } else socket.send(JSON.stringify({ id: message.id, result: { pageId: "page-1", url: "https://example.com" } }));
    });
    await client.action({ type: "workflow_begin", workflowId: id });
    const failed = await client.action({ type: "workflow_step" });
    assert.equal(failed.state, "failed");
    assert.equal(failed.retryRequired, true);
    assert.equal(failed.attempts, 1);
    assert.match(failed.lastError, /stale/);
    await client.action({ type: "workflow_step" });
    assert.equal(staleChecks, 1, "no implicit replay retry");
    assert.equal((await client.action({ type: "workflow_step", retry: true })).attempts, 2);
    assert.equal(staleChecks, 2);
    assert.equal(mutations, 0, "a replacement page never receives the stale page's mutation");
  });
});
