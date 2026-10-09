import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = await mkdtemp(path.join(os.tmpdir(), "browserpilot-try-"));
const probe = createServer();
let client;
let transport;
let port;
let completed = false;
let phase = "local setup";
let startupStderr = Buffer.alloc(0);
let startupDiagnostic;

try {
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  // Never inherit the user's pairing, browser profile or daily companion settings.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) =>
    value !== undefined && !key.toUpperCase().startsWith("BROWSERPILOT_")));
  Object.assign(env, {
    // Keep Playwright's startup artifacts inside the exercise's owned cleanup.
    TEMP: temp, TMP: temp, TMPDIR: temp,
    BROWSERPILOT_DATA_DIR: temp,
    BROWSERPILOT_CONFIG_PATH: path.join(temp, "config.json"),
    BROWSERPILOT_COMPANION_TOKEN: randomBytes(48).toString("base64url"),
    BROWSERPILOT_COMPANION_PORT: String(port),
    BROWSERPILOT_BROWSER_BACKEND: "playwright",
    BROWSERPILOT_HEADLESS: "1",
    BROWSERPILOT_PROFILE_DIR: path.join(temp, "profile"),
    BROWSERPILOT_DOWNLOAD_DIR: path.join(temp, "downloads"),
    BROWSERPILOT_UPLOAD_DIR: path.join(temp, "uploads"),
  });
  console.log("Opening https://example.com in temporary sandboxed Chromium. No account or model API key is used.");
  transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(root, "dist", "cli", "index.js"), "mcp"], env, stderr: "pipe" });
  // Drain the pipe so startup errors cannot block the child. Keep only bounded
  // diagnostic context; never print raw server logs, paths or credential content.
  transport.stderr?.on("data", (chunk) => {
    if (phase !== "MCP startup") return;
    startupStderr = Buffer.concat([startupStderr, Buffer.from(chunk)]).subarray(-16_384);
    const diagnostic = startupStderr.toString("utf8");
    if (/Executable doesn't exist/i.test(diagnostic)) startupDiagnostic = "missing_browser";
    else if (/Host system is missing dependencies|error while loading shared libraries/i.test(diagnostic)) startupDiagnostic = "missing_dependencies";
  });
  client = new Client({ name: "browserpilot-first-run", version: "1.0.0" });
  phase = "MCP startup";
  await client.connect(transport, { timeout: 60_000 });
  phase = "MCP tool listing";
  startupStderr = Buffer.alloc(0);
  startupDiagnostic = undefined;
  const tools = (await client.listTools()).tools;
  const call = async (name, args = {}) => {
    phase = name;
    const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
    if (response.isError) throw new Error(`${name} failed: ${JSON.stringify(response.structuredContent?.error || response.content)}`);
    return response;
  };
  const opened = (await call("browser_open", { url: "https://example.com" })).structuredContent.result;
  assert.ok(opened.text?.trim(), "The public page must return visible text");
  const pageId = opened.pageId;
  assert.equal(typeof pageId, "string");
  const links = (await call("browser_extract", { pageId, request: { mode: "links", limit: 5 } })).structuredContent.result;
  const screenshot = await call("browser_screenshot", { pageId, fullPage: true });
  const image = screenshot.content.find((item) => item.type === "image");
  assert.ok(image?.data, "MCP must deliver actual image content");
  const staged = (await call("browser_stage_file", { filename: "hello.txt",
    base64: Buffer.from("Hello from BrowserPilot").toString("base64") })).structuredContent.result;
  const read = await call("browser_read_file", { fileId: staged.id });
  assert.match(JSON.stringify(read.content), /Hello from BrowserPilot/);
  await call("browser_close_tab", { pageId });
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version,
    tools: tools.length, title: opened.title, links,
    screenshot: { mimeType: image.mimeType, bytes: Buffer.from(image.data, "base64").length },
    fileRoundTrip: true, dailyProfileUsed: false, websiteWritesPerformed: false }, null, 2));
  completed = true;
} catch (error) {
  console.error(`Failed during ${phase}: ${error instanceof Error ? error.message : String(error)}`);
  if (phase === "MCP startup" && startupDiagnostic === "missing_browser") {
    console.error("Chromium is missing from the configured Playwright browser cache. Run npx playwright install chromium in this same environment, then rerun npm run try:browser.");
  } else if (phase === "MCP startup" && startupDiagnostic === "missing_dependencies") {
    console.error("Chromium system libraries are missing. Install them through your OS-approved installation process, then rerun npm run try:browser. No sandbox bypass is provided.");
  } else {
    console.error("Check Node 22+, run npx playwright install chromium, and confirm HTTPS access to example.com. Linux may need Chromium system libraries; use your OS-approved installation process. No sandbox bypass is provided.");
  }
  process.exitCode = 1;
} finally {
  if (probe.listening) await new Promise((resolve) => probe.close(resolve));
  await client?.close().catch(() => undefined);
  await transport?.close().catch(() => undefined);
  // The stdio runtime owns this companion; its disconnect must release the port.
  let stopped = !port;
  for (let attempt = 0; port && attempt < 50; attempt++) {
    try { await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) }); }
    catch { stopped = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (stopped) {
    try {
      await rm(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      if (completed) console.log("PASS: real browser read, extraction, MCP image/file transfer and owned-process cleanup. Temporary profile removed.");
    } catch {
      console.error("Temporary profile is still locked; cleanup did not pass. Close only this exercise's browser before removing its temporary state.");
      process.exitCode = 1;
    }
  } else {
    console.error("Cleanup could not verify companion shutdown; temporary state retained. Do not kill unrelated BrowserPilot processes.");
    process.exitCode = 1;
  }
}
