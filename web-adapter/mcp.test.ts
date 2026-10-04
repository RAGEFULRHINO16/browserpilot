import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { POST } from "./app/api/mcp/route";

test("optional HTTP requires an independent bearer and rejects foreign origins/rebinding hosts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "browserpilot-http-"));
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) if (key.startsWith("BROWSERPILOT_")) delete process.env[key];
  const companionToken = randomBytes(48).toString("base64url");
  const mcpToken = randomBytes(48).toString("base64url");
  process.env.BROWSERPILOT_CONFIG_PATH = path.join(root, "config.json");
  process.env.BROWSERPILOT_DATA_DIR = root;
  process.env.BROWSERPILOT_COMPANION_TOKEN = companionToken;
  const makeRequest = (headers: Record<string, string> = {}) => new Request("http://127.0.0.1:3000/api/mcp", {
    method: "POST", headers: { host: "127.0.0.1:3000", "content-type": "application/json",
      accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "portable-http-test", version: "1.0.0" },
    } }),
  });
  try {
    assert.equal((await POST(makeRequest({ authorization: `Bearer ${mcpToken}` }))).status, 401, "missing MCP token fails closed");
    process.env.BROWSERPILOT_MCP_TOKEN = companionToken;
    assert.equal((await POST(makeRequest({ authorization: `Bearer ${companionToken}` }))).status, 401, "reused companion token fails closed");
    process.env.BROWSERPILOT_MCP_TOKEN = mcpToken;
    assert.equal((await POST(makeRequest())).status, 401);
    assert.equal((await POST(makeRequest({ authorization: "Bearer invalid" }))).status, 401);
    assert.equal((await POST(makeRequest({ authorization: `Bearer ${companionToken}` }))).status, 401);
    assert.equal((await POST(makeRequest({ host: "attacker.example:3000", authorization: `Bearer ${mcpToken}` }))).status, 403);
    assert.equal((await POST(makeRequest({ origin: "https://attacker.example", authorization: `Bearer ${mcpToken}` }))).status, 403);
    const initialized = await POST(makeRequest({ authorization: `Bearer ${mcpToken}` }));
    assert.equal(initialized.status, 200);
    assert.match(await initialized.text(), /serverInfo/);
  } finally {
    for (const key of Object.keys(process.env)) if (key.startsWith("BROWSERPILOT_")) delete process.env[key];
    for (const [key, value] of Object.entries(saved)) if (key.startsWith("BROWSERPILOT_") && value !== undefined) process.env[key] = value;
    await rm(root, { recursive: true, force: true });
  }
});
