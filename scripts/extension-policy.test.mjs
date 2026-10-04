import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { privateHost, sitePattern } from "../extension/policy.js";

test("website permissions are optional, not granted on installation", async () => {
  const manifest = JSON.parse(await readFile(new URL("../extension/manifest.json", import.meta.url)));
  assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1/*"]);
  assert.ok(manifest.optional_host_permissions.includes("https://*/*"));
});

test("private, special-use and disguised IP hosts cannot be granted", () => {
  for (const host of ["localhost", "localhost.", "router.local", "10.1.2.3", "100.64.0.1", "192.168.1.1", "198.18.0.1", "[::1]", "[::ffff:127.0.0.1]"]) assert.equal(privateHost(host), true, host);
  for (const url of ["http://2130706433", "http://0x7f000001", "http://127.1", "http://[::ffff:127.0.0.1]", "file:///tmp/test", "https://user:pass@example.com", "https://accounts.google.com"]) assert.throws(() => sitePattern(url), undefined, url);
  assert.equal(sitePattern("https://example.com/a?b=c"), "https://example.com/*");
});
