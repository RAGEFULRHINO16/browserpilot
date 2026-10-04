import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

async function unusedPort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

test("real MCP stdio handshake lists all tools and invokes the isolated authenticated companion", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "browserpilot-stdio-"));
  const port = await unusedPort();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.startsWith("BROWSERPILOT_"))) as Record<string, string>;
  Object.assign(env, {
    BROWSERPILOT_DATA_DIR: root,
    BROWSERPILOT_CONFIG_PATH: path.join(root, "config.json"),
    BROWSERPILOT_COMPANION_TOKEN: randomBytes(48).toString("base64url"),
    BROWSERPILOT_COMPANION_PORT: String(port),
    BROWSERPILOT_BROWSER_BACKEND: "extension",
    BROWSERPILOT_DOWNLOAD_DIR: path.join(root, "downloads"),
    BROWSERPILOT_UPLOAD_DIR: path.join(root, "uploads"),
  });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.resolve("dist/cli/index.js"), "mcp"], env, stderr: "pipe" });
  let diagnostics = "";
  transport.stderr?.on("data", (chunk) => { diagnostics += String(chunk); });
  const client = new Client({ name: "browserpilot-portable-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 50);
    const profiles = await client.callTool({ name: "browser_profiles", arguments: {} });
    assert.equal(profiles.isError, undefined);
    assert.deepEqual(profiles.structuredContent, { result: [] });
    const staged = await client.callTool({ name: "browser_stage_file", arguments: { filename: "test.txt", base64: Buffer.from("MCP portable success").toString("base64") } });
    assert.equal(staged.isError, undefined);
    const file = (staged.structuredContent as { result: { id: string } }).result;
    const read = await client.callTool({ name: "browser_read_file", arguments: { fileId: file.id } });
    assert.equal(read.isError, undefined);
    assert.match(JSON.stringify(read.content), /MCP portable success/);
    const unauthorized = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(unauthorized.status, 401);
    const malformed = await client.callTool({ name: "browser_fill", arguments: { index: -1, text: "no" } });
    assert.equal(malformed.isError, true);
  } catch (error) {
    throw new Error(`MCP integration failed. Companion diagnostics: ${diagnostics}`, { cause: error });
  } finally {
    await client.close();
    await new Promise((resolve) => setTimeout(resolve, 250));
    await rm(root, { recursive: true, force: true });
  }
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) }));
});

test("isolated Playwright MCP disconnect closes Chromium and releases its profile", {
  timeout: 45_000, skip: process.env.BROWSERPILOT_BROWSER_SECURITY_TEST !== "1",
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "browserpilot-browser-cleanup-"));
  const port = await unusedPort();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) =>
    value !== undefined && !key.toUpperCase().startsWith("BROWSERPILOT_"))) as Record<string, string>;
  Object.assign(env, { BROWSERPILOT_DATA_DIR: root,
    BROWSERPILOT_CONFIG_PATH: path.join(root, "config.json"),
    BROWSERPILOT_COMPANION_TOKEN: randomBytes(48).toString("base64url"),
    BROWSERPILOT_COMPANION_PORT: String(port), BROWSERPILOT_BROWSER_BACKEND: "playwright",
    BROWSERPILOT_HEADLESS: "1", BROWSERPILOT_PROFILE_DIR: path.join(root, "profile"),
    BROWSERPILOT_DOWNLOAD_DIR: path.join(root, "downloads"), BROWSERPILOT_UPLOAD_DIR: path.join(root, "uploads") });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.resolve("dist/cli/index.js"), "mcp"], env, stderr: "pipe" });
  const client = new Client({ name: "browserpilot-browser-cleanup", version: "1.0.0" });
  try {
    await client.connect(transport);
    const status = await client.callTool({ name: "browser_status", arguments: {} });
    assert.equal(status.isError, undefined);
    assert.equal((status.structuredContent as { result: { ready: boolean } }).result.ready, true);
    const screenshot = await client.callTool({ name: "browser_screenshot", arguments: {} });
    assert.equal(screenshot.isError, undefined);
    assert.ok(screenshot.content.some((item) => item.type === "image"));
  } finally {
    await client.close();
    await transport.close();
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) }));
});
