import assert from "node:assert/strict";
import test from "node:test";
import { ObservationHistory } from "./observations";

test("observations preserve cross-site and same-tab history without URL secrets", () => {
  const history = new ObservationHistory();
  history.record("personal", "page-1", "https://user:password@example.com/article?token=secret#fragment", "extract");
  history.record("personal", "page-1", "https://example.org/destination", "open");
  history.record("client", "page-2", "https://client.example/private", "snapshot");
  const entries = history.recent("personal");
  assert.deepEqual(entries.map((entry) => entry.url), ["https://example.com/article", "https://example.org/destination"]);
  assert.equal(entries[0].operation, "extract");
  assert.match(entries[0].observationId, /^[a-f0-9]{32}$/);
  entries[0].url = "forged";
  assert.equal(history.recent("personal")[0].url, "https://example.com/article");
  assert.equal(history.recent("client").length, 1);
  assert.equal(history.recent("absent").length, 0);
});

test("observation metadata is bounded, expiring, and ignores non-web pages", () => {
  let now = 0;
  const history = new ObservationHistory(() => now);
  history.record("default", "page-1", "file:///secret.txt", "snapshot");
  history.record("default", "page-1", "invalid", "snapshot");
  assert.equal(history.recent("default").length, 0);
  for (let index = 0; index < 100; index++) history.record("default", "page-1", `https://example.com/${index}`, "snapshot");
  assert.equal(history.recent("default").length, 8);
  history.record("default", "page-1", "https://example.com/99", "extract");
  assert.equal(history.recent("default").length, 8);
  assert.equal(history.recent("default").at(-1)?.operation, "extract");
  now = 10 * 60_000;
  assert.deepEqual(history.recent("default"), []);
});
