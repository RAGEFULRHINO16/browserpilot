import assert from "node:assert/strict";
import test from "node:test";
import { toolResult } from "./companion";

test("file results use the correct MCP content type", () => {
  const image = toolResult({ id: "image-1", name: "pin.jpg", mimeType: "image/jpeg", data: "YWJj" });
  assert.equal(image.content[0].type, "image");

  const pdf = toolResult({ id: "pdf-1", name: "page.pdf", mimeType: "application/pdf", data: "YWJj" });
  assert.equal(pdf.content[0].type, "resource");
  assert.deepEqual("resource" in pdf.content[0] ? pdf.content[0].resource : undefined, {
    uri: "browserpilot://file/pdf-1", mimeType: "application/pdf", blob: "YWJj",
  });
});

test("visual reading includes page text and an MCP image", () => {
  const result = toolResult({ snapshot: { pageId: "page-123", text: "Rendered page" }, mimeType: "image/jpeg", data: "YWJj" });
  assert.deepEqual(result.content.map((item) => item.type), ["text", "image"]);
});

test("visual observation transfers multiple frames without duplicating image data in metadata", () => {
  const result = toolResult({ snapshot: { pageId: "page-123" }, mediaBefore: [], mediaAfter: [],
    visualChangeDetected: true, truncated: false, frames: [
      { offsetMs: 0, mimeType: "image/jpeg", data: "YWJj" },
      { offsetMs: 750, mimeType: "image/jpeg", data: "ZGVm" },
    ] });
  assert.deepEqual(result.content.map((item) => item.type), ["text", "text", "image", "text", "image"]);
  assert.equal(JSON.stringify(result.structuredContent).includes("YWJj"), false);
});
