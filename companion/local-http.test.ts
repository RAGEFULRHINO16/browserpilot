import assert from "node:assert/strict";
import test from "node:test";
import { localRequestAllowed } from "./local-http";

test("loopback API rejects DNS rebinding and mismatched authorities", () => {
  assert.equal(localRequestAllowed({ headers: { host: "127.0.0.1:8765" } }, 8765), true);
  for (const host of ["attacker.example:8765", "127.0.0.1:3000", "127.0.0.1:8765@attacker.example", "localhost:8765/path"]) {
    assert.equal(localRequestAllowed({ headers: { host } }, 8765), false, host);
  }
  assert.equal(localRequestAllowed({ headers: {} }, 8765), false);
});

test("approval POSTs require the exact local origin", () => {
  const headers = { host: "127.0.0.1:8765", origin: "http://127.0.0.1:8765" };
  assert.equal(localRequestAllowed({ headers }, 8765, { requireOrigin: true }), true);
  for (const origin of [undefined, "null", "http://attacker.example", "http://localhost:8765", "http://127.0.0.1:3000", "http://127.0.0.1:8765/path"]) {
    assert.equal(localRequestAllowed({ headers: { ...headers, origin } }, 8765, { requireOrigin: true }), false);
  }
  assert.equal(localRequestAllowed({ headers: { ...headers, "sec-fetch-site": "cross-site" } }, 8765, { requireOrigin: true }), false);
});

test("extension handshakes require a loopback host and extension origin", () => {
  const headers = { host: "127.0.0.1:8765", origin: `chrome-extension://${"a".repeat(32)}` };
  assert.equal(localRequestAllowed({ headers }, 8765, { extensionOrigin: true }), true);
  assert.equal(localRequestAllowed({ headers: { ...headers, host: "attacker.example:8765" } }, 8765, { extensionOrigin: true }), false);
  assert.equal(localRequestAllowed({ headers: { ...headers, origin: "http://127.0.0.1:8765" } }, 8765, { extensionOrigin: true }), false);
});
