import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { WebSocket } from "ws";

test("real companion blocks rebinding and unapproved innocuous-label mutations", { timeout: 30_000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "browserpilot-security-"));
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const port = address.port;
  const token = randomBytes(32).toString("hex");
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--import", "tsx", "companion/server.ts"], {
    cwd: process.cwd(), windowsHide: true,
    env: { ...process.env, BROWSERPILOT_COMPANION_TOKEN: token, BROWSERPILOT_COMPANION_PORT: String(port),
      BROWSERPILOT_BROWSER_BACKEND: "extension", BROWSERPILOT_DATA_DIR: temporary,
      BROWSERPILOT_CONFIG_PATH: path.join(temporary, "config.json"), BROWSERPILOT_PROFILE_DIR: path.join(temporary, "profile"),
      BROWSERPILOT_DOWNLOAD_DIR: path.join(temporary, "downloads"), BROWSERPILOT_UPLOAD_DIR: path.join(temporary, "uploads") },
    stdio: "ignore",
  });
  let socket: WebSocket | undefined;
  try {
    let ready = false;
    const startupDeadline = Date.now() + 15_000;
    while (Date.now() < startupDeadline) {
      const health = await fetch(`${base}/health`, { headers: { authorization: `Bearer ${token}` } }).catch(() => undefined);
      if (health?.ok) { ready = true; break; }
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("Isolated companion failed to start.");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, "isolated companion became ready within 15 seconds");
    const health = async () => (await (await fetch(`${base}/health`, { headers: { authorization: `Bearer ${token}` } })).json());
    const offline = await health();
    assert.equal(offline.serviceReady, true);
    assert.equal(offline.ready, false, "companion availability does not imply an extension is connected");
    assert.deepEqual(offline.connectedProfiles, []);
    assert.equal(offline.queueDepth, 0);
    assert.ok(offline.memory.rssBytes > 0 && offline.memory.heapUsedBytes > 0);
    assert.ok(offline.uptimeSeconds > 0);
    const rebinding = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const outgoing = httpRequest(`${base}/approvals`, { headers: { host: `attacker.example:${port}` } }, (response) => {
        let text = "";
        response.on("data", (chunk) => { text += chunk; });
        response.on("end", () => resolve({ status: response.statusCode || 0, text }));
        response.on("error", reject);
      });
      outgoing.on("error", reject);
      outgoing.end();
    });
    assert.equal(rebinding.status, 403);
    assert.equal(rebinding.text.includes('name="csrf"'), false);
    assert.equal((await fetch(`${base}/health`)).status, 401);

    socket = new WebSocket(`ws://127.0.0.1:${port}/bridge`, { origin: `chrome-extension://${"a".repeat(32)}` });
    await once(socket, "open");
    const paired = once(socket, "message");
    socket.send(JSON.stringify({ type: "hello", profileId: "default",
      token: createHmac("sha256", token).update("browserpilot-brave-extension-v1").digest("hex") }));
    await paired;
    assert.equal((await health()).ready, true);
    assert.deepEqual((await health()).connectedProfiles, ["default"]);
    let mutations = 0;
    let pageUrl = "https://example.com/?recipient=1";
    let snapshotUrlOverride: string | undefined;
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (!message.command) return;
      let result: unknown = { pageId: "page-1", url: pageUrl };
      if (message.command === "snapshot" && snapshotUrlOverride) result = { pageId: "page-1", url: snapshotUrlOverride };
      if (message.command === "url") result = pageUrl;
      if (message.command === "dom") result = { label: "Continue", tag: "button", type: "button", fingerprint: "stable-button" };
      if (message.command === "interact" || message.command === "press") mutations++;
      socket?.send(JSON.stringify({ id: message.id, result }));
    });
    const action = async (input: object) => {
      const response = await fetch(`${base}/action`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(input) });
      assert.equal(response.status, 200);
      return (await response.json()).result;
    };
    await action({ type: "workflow_start", name: "Bounded recording" });
    for (let index = 0; index < 101; index++) {
      const result = await action({ type: "scroll", direction: "down", pixels: 10, pageId: "page-1" });
      if (index >= 99) assert.match(result.workflowRecordingWarning, /action succeeded/);
    }
    assert.equal((await action({ type: "workflow_status" })).recording.steps, 100);
    assert.equal((await action({ type: "workflow_stop" })).steps, 100);
    const approve = async (id: string) => {
      const page = await (await fetch(`${base}/approvals`)).text();
      const csrf = page.match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
      assert.ok(csrf);
      const malicious = await fetch(`${base}/approvals/${id}`, { method: "POST", redirect: "manual",
        headers: { origin: "https://attacker.example", "content-type": "application/x-www-form-urlencoded" }, body: `csrf=${csrf}` });
      assert.equal(malicious.status, 403);
      const approved = await fetch(`${base}/approvals/${id}`, { method: "POST", redirect: "manual",
        headers: { origin: base, "content-type": "application/x-www-form-urlencoded" }, body: `csrf=${csrf}` });
      assert.equal(approved.status, 303);
    };
    const click = { type: "click", index: 0, pageId: "page-1" };
    pageUrl = "https://example.net/article-a?token=do-not-display";
    await action({ type: "snapshot", pageId: "page-1" });
    pageUrl = "https://example.com/workspace-b?recipient=1";
    const pending = await action(click);
    assert.equal(pending.approvalRequired, true);
    assert.match(pending.contextDigest, /^[a-f0-9]{64}$/);
    assert.equal(mutations, 0);
    const evidence = await (await fetch(`${base}/approvals`)).text();
    assert.ok(evidence.includes("https://example.net/article-a"));
    assert.ok(evidence.includes("https://example.com/workspace-b"));
    assert.ok(evidence.includes("recentPageObservations"));
    assert.ok(evidence.includes("actionDestination"));
    assert.equal(evidence.includes("do-not-display"), false);
    await action({ type: "snapshot", pageId: "page-1" });
    const retry = await action(click);
    assert.equal(retry.approvalId, pending.approvalId);
    assert.equal(retry.contextDigest, pending.contextDigest, "new reads do not rewrite evidence in a pending approval");
    await approve(pending.approvalId);
    await action({ ...click, approvalId: pending.approvalId });
    assert.equal(mutations, 1);
    assert.equal((await action({ ...click, approvalId: pending.approvalId })).approvalRequired, true);
    assert.equal(mutations, 1, "one-time grant cannot replay");

    for (const input of [{ type: "fill", index: 0, text: "draft", pageId: "page-1" },
      { type: "press", key: "Escape", pageId: "page-1" },
      { type: "interact", action: "right_click", target: { by: "text", value: "Continue" }, pageId: "page-1" },
      { type: "interact", action: "select_option", target: { by: "css", value: "select" }, values: ["public"], pageId: "page-1" }]) {
      assert.equal((await action(input)).approvalRequired, true);
    }
    assert.equal(mutations, 1, "alternative actuation paths cannot bypass approval");
    const destinationApproval = await action(click);
    await approve(destinationApproval.approvalId);
    pageUrl = "https://example.com/?recipient=2";
    assert.equal((await action({ ...click, approvalId: destinationApproval.approvalId })).approvalRequired, true);
    assert.equal(mutations, 1, "a changed URL query invalidates the approved action");
    snapshotUrlOverride = "https://example.gov/stale-snapshot";
    pageUrl = "https://example.edu/raced-navigation";
    await action({ type: "snapshot", pageId: "page-1" });
    snapshotUrlOverride = undefined;
    pageUrl = "https://example.com/normal-destination";
    await action({ ...click, index: 1 });
    const raceHtml = await (await fetch(`${base}/approvals`)).text();
    assert.equal(raceHtml.includes("raced-navigation"), false, "mismatched snapshot and browser URL must not create misleading evidence");
    assert.equal(raceHtml.includes("stale-snapshot"), false);
    const disconnected = once(socket, "close");
    socket.close();
    await disconnected;
    assert.equal((await health()).ready, false);
    assert.equal((await action({ type: "status" })).ready, false, "status remains usable for offline recovery");
  } finally {
    socket?.terminate();
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, "exit");
      child.kill();
      await stopped;
    }
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
    assert.equal(path.basename(temporary).startsWith("browserpilot-security-"), true);
    await rm(temporary, { recursive: true, force: true });
  }
});
