import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { callCompanion, CompanionError } from "./companion";

test("transport classifies rejected and malformed responses without leaking credentials or retrying writes", async () => {
  let responseStatus = 200;
  let responseBody = JSON.stringify({ result: { ready: true } });
  let calls = 0;
  const server = createServer((request, response) => {
    calls++;
    assert.equal(request.url, "/action");
    response.writeHead(responseStatus, { "content-type": "application/json" });
    response.end(responseBody);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const saved = { url: process.env.BROWSERPILOT_COMPANION_URL, token: process.env.BROWSERPILOT_COMPANION_TOKEN };
  process.env.BROWSERPILOT_COMPANION_URL = `http://127.0.0.1:${address.port}`;
  process.env.BROWSERPILOT_COMPANION_TOKEN = "fixture-private-token-never-in-errors";
  try {
    assert.deepEqual(await callCompanion({ type: "status" }), { ready: true });
    for (const [status, body, code, unknown] of [
      [401, "not JSON", "AUTHENTICATION_FAILED", false],
      [429, "not JSON", "QUEUE_FULL", false],
      [200, "not JSON", "INVALID_RESPONSE", true],
      [200, "null", "INVALID_RESPONSE", true],
      [400, JSON.stringify({ error: "Page ID is stale. List tabs again." }), "STALE_PAGE", false],
      [400, JSON.stringify({ error: "Extension timed out during interact" }), "ACTION_TIMEOUT", true],
    ] as const) {
      responseStatus = status;
      responseBody = body;
      const before = calls;
      await assert.rejects(callCompanion({ type: "click", index: 0 }), (error: unknown) => {
        assert.ok(error instanceof CompanionError);
        assert.equal(error.code, code);
        assert.equal(error.outcomeUnknown, unknown);
        assert.equal(error.retryable, false);
        assert.equal(JSON.stringify(error).includes(process.env.BROWSERPILOT_COMPANION_TOKEN!), false);
        return true;
      });
      assert.equal(calls, before + 1, "a failed write is submitted exactly once");
    }
  } finally {
    if (saved.url === undefined) delete process.env.BROWSERPILOT_COMPANION_URL; else process.env.BROWSERPILOT_COMPANION_URL = saved.url;
    if (saved.token === undefined) delete process.env.BROWSERPILOT_COMPANION_TOKEN; else process.env.BROWSERPILOT_COMPANION_TOKEN = saved.token;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
