import assert from "node:assert/strict";
import test from "node:test";
import { downloadPublicHttps, pinnedLookup } from "./public-download";

test("server downloads reject loopback, mapped private IPv6 and non-HTTPS destinations", async () => {
  for (const url of ["https://127.0.0.1/image", "https://[::ffff:c0a8:101]/image", "http://1.1.1.1/image", "file:///etc/passwd"]) {
    await assert.rejects(downloadPublicHttps(url, { maxBytes: 1024 }), /public HTTPS/);
  }
});

test("lookup pins validated addresses without resolving the hostname again", () => {
  const lookup = pinnedLookup([{ address: "1.1.1.1", family: 4 }, { address: "2606:4700:4700::1111", family: 6 }]);
  lookup("untrusted.example", {}, (error, address, family) => {
    assert.equal(error, null);
    assert.equal(address, "1.1.1.1");
    assert.equal(family, 4);
  });
  lookup("untrusted.example", { family: 6 }, (error, address, family) => {
    assert.equal(error, null);
    assert.equal(address, "2606:4700:4700::1111");
    assert.equal(family, 6);
  });
  lookup("untrusted.example", { all: true }, (error, addresses) => {
    assert.equal(error, null);
    assert.equal(Array.isArray(addresses), true);
    assert.equal((addresses as unknown[]).length, 2);
  });
});
