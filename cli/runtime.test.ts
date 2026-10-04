import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import test from "node:test";
import type { BrowserPilotConfig } from "../companion/config";
import { ensureCompanion, inspectCompanion, ManagedCompanion } from "./runtime";

function config(port: number): BrowserPilotConfig {
  return { companionPort: port, token: randomBytes(48).toString("base64url"), backend: "extension", headless: false,
    configPath: "unused-config.json", dataDir: "unused-data", profileDir: "unused-profile", downloadDir: "unused-downloads", uploadDir: "unused-uploads" };
}

async function withServer(handler: (response: ServerResponse) => void, run: (settings: BrowserPilotConfig) => Promise<void>) {
  const server = createServer((_request, response) => handler(response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try { await run(config(address.port)); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}

test("running but unpaired companion is reused; health output excludes arbitrary response fields", async () => {
  await withServer((response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ready: false, serviceReady: true, backend: "extension", connectedProfiles: [], token: "DO-NOT-EXPORT",
      memory: { rssBytes: 100_000, heapUsedBytes: 20_000, secret: "DO-NOT-EXPORT" }, uptimeSeconds: 12.5, queueDepth: 1,
      workflows: { catalogReady: true, replayReady: false, warnings: ["DO-NOT-EXPORT"] } }));
  }, async (settings) => {
    const inspected = await inspectCompanion(settings);
    assert.equal(inspected.state, "browser_not_ready");
    assert.equal(inspected.health?.serviceReady, true);
    assert.deepEqual(inspected.health?.memory, { rssBytes: 100_000, heapUsedBytes: 20_000 });
    assert.equal(inspected.health?.uptimeSeconds, 12.5);
    assert.equal(inspected.health?.queueDepth, 1);
    assert.deepEqual(inspected.health?.workflows, { catalogReady: true, replayReady: false, warningCount: 1 });
    assert.equal(JSON.stringify(inspected).includes("DO-NOT-EXPORT"), false);
    let launched = false;
    const reused = await ensureCompanion(settings, "unused.js", { spawn: () => { launched = true; throw new Error("Must not spawn."); } });
    assert.equal(reused, undefined);
    assert.equal(launched, false);
    const managed = new ManagedCompanion(settings, "unused.js", { spawn: () => { throw new Error("Must not spawn."); } });
    await managed.ensureRunning();
    await managed.close();
    assert.equal((await inspectCompanion(settings)).state, "browser_not_ready");
  });
});

test("occupied auth-conflict, wrong-backend and malformed ports never trigger a new process", async () => {
  for (const [expected, handler] of [
    ["auth_conflict", (response: ServerResponse) => { response.writeHead(401); response.end("PRIVATE-CONTENT"); }],
    ["backend_mismatch", (response: ServerResponse) => { response.end(JSON.stringify({ ready: true, backend: "playwright" })); }],
    ["invalid_response", (response: ServerResponse) => { response.end("PRIVATE-CONTENT"); }],
  ] as const) {
    await withServer(handler, async (settings) => {
      const inspected = await inspectCompanion(settings);
      assert.equal(inspected.state, expected);
      assert.equal(JSON.stringify(inspected).includes("PRIVATE-CONTENT"), false);
      await assert.rejects(ensureCompanion(settings, "unused.js", { spawn: () => { throw new Error("Must not spawn."); } }),
        (error: unknown) => error instanceof Error && !error.message.includes("Must not spawn."));
    });
  }
});

test("unresponsive occupied ports have bounded diagnostics and never trigger startup", async () => {
  await withServer(() => undefined, async (settings) => {
    const started = Date.now();
    assert.equal((await inspectCompanion(settings, 30)).state, "unresponsive");
    assert.ok(Date.now() - started < 1000);
    await assert.rejects(ensureCompanion(settings, "unused.js", { timeoutMs: 100,
      spawn: () => { throw new Error("Must not spawn."); } }), /did not answer/);
  });
});

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

test("startup timeout terminates only the child launched for that attempt", async () => {
  const settings = config(await unusedPort());
  let owned: ChildProcess | undefined;
  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  try {
    await assert.rejects(ensureCompanion(settings, "unused.js", { timeoutMs: 150, pollIntervalMs: 10, spawn: () => {
      owned = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
      return owned;
    } }), /did not start within/);
    assert.ok(owned);
    assert.ok(owned.exitCode !== null || owned.signalCode !== null);
    assert.equal(unrelated.exitCode, null);
    assert.equal(unrelated.signalCode, null);
  } finally { unrelated.kill(); await once(unrelated, "exit"); }
});

test("managed recovery starts once after an owned crash and closes its replacement", async () => {
  const settings = config(await unusedPort());
  const children: ChildProcess[] = [];
  const manager = new ManagedCompanion(settings, "fixture", { timeoutMs: 3000, pollIntervalMs: 20, spawn: () => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import {createServer} from 'node:http';
      createServer((request,response) => {
        if(request.headers.authorization !== 'Bearer ' + process.env.FIXTURE_TOKEN) {response.writeHead(401);response.end();return;}
        response.end(JSON.stringify({ready:false,serviceReady:true,backend:'extension',connectedProfiles:[]}));
      }).listen(Number(process.env.FIXTURE_PORT),'127.0.0.1');
    `], { env: { ...process.env, FIXTURE_PORT: String(settings.companionPort), FIXTURE_TOKEN: settings.token }, stdio: "ignore", windowsHide: true });
    children.push(child);
    return child;
  } });
  try {
    await Promise.all([manager.ensureRunning(), manager.ensureRunning(), manager.ensureRunning()]);
    assert.equal(children.length, 1);
    const exited = once(children[0], "exit");
    children[0].kill();
    await exited;
    await Promise.all([manager.ensureRunning(), manager.ensureRunning()]);
    assert.equal(children.length, 2);
    assert.equal(manager.ownedProcessId, children[1].pid);
    assert.equal((await inspectCompanion(settings)).state, "browser_not_ready");
  } finally { await manager.close(); }
  assert.equal((await inspectCompanion(settings)).state, "offline");
  await assert.rejects(manager.ensureRunning(), /session is closed/);
});
