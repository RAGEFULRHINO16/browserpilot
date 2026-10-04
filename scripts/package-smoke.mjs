import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, stat, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run this check with npm run test:package.");
const temp = await mkdtemp(path.join(os.tmpdir(), "browserpilot-package-"));
const token = randomBytes(48).toString("base64url");
let client;
let port;

async function footprint(directory) {
  let bytes = 0, files = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const child = await footprint(name); bytes += child.bytes; files += child.files;
    } else if (entry.isFile()) { bytes += (await stat(name)).size; files++; }
  }
  return { bytes, files };
}

try {
  execFileSync(process.execPath, [npm, "pack", "--workspaces=false", "--pack-destination", temp], { cwd: root, stdio: "pipe" });
  const archive = (await readdir(temp)).find((name) => name.endsWith(".tgz"));
  assert.ok(archive);
  execFileSync(process.execPath, [npm, "install", "--prefix", path.join(temp, "install"), "--ignore-scripts", "--omit=dev", "--workspaces=false", path.join(temp, archive)], { cwd: root, stdio: "pipe" });
  const modules = path.join(temp, "install", "node_modules");
  for (const name of ["next", "react", "react-dom", "mcp-handler", "jose"]) {
    assert.equal((await readdir(modules)).includes(name), false, `stdio install unexpectedly includes ${name}`);
  }
  const installed = path.join(modules, "browserpilot", "dist", "cli", "index.js");
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.startsWith("BROWSERPILOT_")));
  Object.assign(env, { BROWSERPILOT_DATA_DIR: path.join(temp, "state"), BROWSERPILOT_CONFIG_PATH: path.join(temp, "state", "config.json"),
    BROWSERPILOT_COMPANION_TOKEN: token, BROWSERPILOT_COMPANION_PORT: String(port), BROWSERPILOT_BROWSER_BACKEND: "extension",
    BROWSERPILOT_DOWNLOAD_DIR: path.join(temp, "downloads"), BROWSERPILOT_UPLOAD_DIR: path.join(temp, "uploads") });
  const start = performance.now();
  const transport = new StdioClientTransport({ command: process.execPath, args: [installed, "mcp"], env, stderr: "pipe" });
  client = new Client({ name: "browserpilot-package-check", version: "1.0.0" });
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 50);
  const coldStartMs = performance.now() - start;
  const staged = await client.callTool({ name: "browser_stage_file", arguments: { filename: "fixture.txt", base64: Buffer.from("verified package round-trip").toString("base64") } });
  assert.equal(staged.isError, undefined);
  const read = await client.callTool({ name: "browser_read_file", arguments: { fileId: staged.structuredContent.result.id } });
  assert.match(JSON.stringify(read.content), /verified package round-trip/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 401);
  const health = async () => (await (await fetch(`http://127.0.0.1:${port}/health`, { headers: { Authorization: `Bearer ${token}` } })).json());
  const before = await health();
  assert.equal(before.serviceReady, true);
  assert.equal(before.ready, false, "an unpaired browser must not look ready");
  const idleStart = performance.now();
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  const idle = await health();
  const installedFootprint = await footprint(modules);
  const report = { platform: process.platform, arch: process.arch, osRelease: os.release(), node: process.version,
    package: archive, installedFootprint, coldStartMs: Math.round(coldStartMs), idleSampleMs: Math.round(performance.now() - idleStart),
    companionIdle: idle.memory, browserRunning: false, methodology: "Fresh temporary production archive install; real MCP stdio initialization and file round-trip; authenticated companion RSS after 10 seconds with extension unpaired. RSS excludes CLI/client/browser. This is one sample, not a memory ceiling." };
  console.log(JSON.stringify(report, null, 2));
  if (process.env.BROWSERPILOT_TEST_ARTIFACT_DIR) {
    await mkdir(process.env.BROWSERPILOT_TEST_ARTIFACT_DIR, { recursive: true });
    await writeFile(path.join(process.env.BROWSERPILOT_TEST_ARTIFACT_DIR, "package-validation.json"), `${JSON.stringify(report, null, 2)}\n`);
  }
  await client.close(); client = undefined;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) }); }
    catch { port = undefined; break; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(port, undefined, "owned companion must stop after the client disconnects");
  console.log("PASS: production package without Next/React; 50-tool MCP handshake, authentication, file transfer and owned-process cleanup.");
} finally {
  await client?.close().catch(() => undefined);
  await rm(temp, { recursive: true, force: true });
}
