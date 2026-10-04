import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { POST } from "../app/api/mcp/route";

test("HTTP MCP rejects missing bearer, foreign origins and rebinding hosts; authenticated initialization works", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "browserpilot-http-"));
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) if (key.startsWith("BROWSERPILOT_")) delete process.env[key];
  const token = randomBytes(48).toString("base64url");
  process.env.BROWSERPILOT_CONFIG_PATH = path.join(root, "config.json");
  process.env.BROWSERPILOT_DATA_DIR = root;
  process.env.BROWSERPILOT_COMPANION_TOKEN = token;
  const makeRequest = (headers: Record<string, string> = {}) => new Request("http://127.0.0.1:3000/api/mcp", {
    method: "POST", headers: { host: "127.0.0.1:3000", "content-type": "application/json",
      accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "portable-http-test", version: "1.0.0" },
    } }),
  });
  try {
    assert.equal((await POST(makeRequest())).status, 401);
    assert.equal((await POST(makeRequest({ authorization: "Bearer invalid" }))).status, 401);
    assert.equal((await POST(makeRequest({ host: "attacker.example:3000", authorization: `Bearer ${token}` }))).status, 403);
    assert.equal((await POST(makeRequest({ origin: "https://attacker.example", authorization: `Bearer ${token}` }))).status, 403);
    const initialized = await POST(makeRequest({ authorization: `Bearer ${token}` }));
    assert.equal(initialized.status, 200);
    const content = await initialized.text();
    assert.match(content, /serverInfo/);
  } finally {
    for (const key of Object.keys(process.env)) if (key.startsWith("BROWSERPILOT_")) delete process.env[key];
    for (const [key, value] of Object.entries(saved)) if (key.startsWith("BROWSERPILOT_") && value !== undefined) process.env[key] = value;
    await rm(root, { recursive: true, force: true });
  }
});
