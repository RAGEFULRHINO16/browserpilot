import assert from "node:assert/strict";
import test from "node:test";
import { isPublicAddress, isPublicUrl } from "./safety";

test("rejects local and private destinations", async () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "192.168.1.1", "169.254.169.254", "192.0.2.1", "198.51.100.2", "203.0.113.3", "::1", "fc00::1", "2001:db8::1",
    "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:c0a8:101", "::127.0.0.1", "64:ff9b::7f00:1", "2002:7f00:1::", "2001:0:4136:e378:8000:63bf:3fff:fdd2"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(await isPublicUrl("http://localhost:3000/"), false);
  assert.equal(await isPublicUrl("http://127.0.0.1/"), false);
  assert.equal(await isPublicUrl("http://[::1]/"), false);
  assert.equal(await isPublicUrl("http://[::ffff:c0a8:101]/"), false);
  assert.equal(await isPublicUrl("file:///C:/Windows/"), false);
  assert.equal(await isPublicUrl("https://user:pass@example.com/"), false);
});

test("accepts ordinary public IPs", () => {
  assert.equal(isPublicAddress("1.1.1.1"), true);
  assert.equal(isPublicAddress("192.0.43.8"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
});
