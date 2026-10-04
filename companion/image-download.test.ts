import assert from "node:assert/strict";
import test from "node:test";
import { fetchPublicImage } from "./image-download";

test("image source downloads reject private or non-HTTPS URLs", async () => {
  await assert.rejects(fetchPublicImage("http://127.0.0.1/image.png"), /public HTTPS/);
  await assert.rejects(fetchPublicImage("https://127.0.0.1/image.png"), /public HTTPS/);
});
