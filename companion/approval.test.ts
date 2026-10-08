import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { ApprovalGate, requiresActionApproval } from "./approval";

test("sensitive actions require one local approval bound to the exact action", () => {
  for (const type of ["click", "download", "fill", "press", "upload"]) assert.equal(requiresActionApproval({ type }), true);
  for (const action of ["click", "double_click", "right_click", "drag", "fill", "select_option"]) {
    assert.equal(requiresActionApproval({ type: "interact", action }), true, action);
  }
  assert.equal(requiresActionApproval({ type: "interact", action: "hover" }), false);
  assert.equal(requiresActionApproval({ type: "wait", request: { trigger: { by: "text", value: "Continue" } } }), true);
  assert.equal(requiresActionApproval({ type: "wait", request: { for: "url_change" } }), false);

  const gate = new ApprovalGate();
  const action = { type: "click", index: 2, pageId: "page-1" };
  const prepared = gate.prepare(action, "Delete project");
  const csrf = gate.html().match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
  assert.ok(csrf);
  assert.equal(gate.consume(prepared.approvalId, action), false);
  assert.equal(gate.approve(prepared.approvalId, "wrong"), false);
  assert.equal(gate.approve(prepared.approvalId, csrf), true);
  assert.equal(gate.consume(prepared.approvalId, { ...action, index: 3 }), false);
  assert.equal(gate.consume(prepared.approvalId, action), true);
  assert.equal(gate.consume(prepared.approvalId, action), false);
});

test("approval binding includes destination and entered text; HTML never trusts page labels", () => {
  const gate = new ApprovalGate("http://127.0.0.1:12345/approvals");
  const action = { request: { type: "fill", text: "draft" }, url: "https://example.com/?recipient=1", target: { fingerprint: "before" } };
  const pending = gate.prepare(action, "<script>alert(1)</script>", { text: "<img src=x>" });
  assert.equal(pending.approvalUrl, "http://127.0.0.1:12345/approvals");
  assert.equal(gate.prepare(action, "duplicate").approvalId, pending.approvalId);
  const html = gate.html();
  assert.equal(pending.requestDigest, createHash("sha256").update(JSON.stringify(action)).digest("hex"));
  assert.ok(html.includes(`title="${pending.requestDigest}"`));
  assert.ok(html.includes(`>${pending.requestDigest.slice(0, 12)}</code>`));
  assert.equal(html.includes("<script>"), false);
  assert.equal(html.includes("<img src=x>"), false);
  const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
  assert.ok(csrf);
  assert.equal(gate.approve(pending.approvalId, csrf), true);
  assert.equal(gate.approve(pending.approvalId, csrf), false);
  assert.equal(gate.consume(pending.approvalId, { ...action, url: "https://example.com/?recipient=2" }), false);
  assert.equal(gate.consume(pending.approvalId, { ...action, target: { fingerprint: "changed" } }), false);
  assert.equal(gate.consume(pending.approvalId, { ...action, request: { ...action.request, text: "sent" } }), false);
  assert.equal(gate.consume(pending.approvalId, action), true);
});

test("pending approval storage is bounded", () => {
  const gate = new ApprovalGate();
  for (let index = 0; index < 128; index++) gate.prepare({ index }, "action");
  assert.throws(() => gate.prepare({ index: 128 }, "action"), /Too many/);
});

test("approval evidence is immutable and hashed alongside the exact request", () => {
  const gate = new ApprovalGate();
  const action = { type: "click", pageId: "page-2" };
  const context = { recentPageObservations: [{ url: "https://example.com/article" }] };
  const pending = gate.prepare(action, "Continue", context);
  const frozen = JSON.stringify(context, null, 2);
  assert.equal(pending.contextDigest, createHash("sha256").update(JSON.stringify({ action, context: frozen })).digest("hex"));
  context.recentPageObservations[0].url = "https://forged.example/";
  const retry = gate.prepare(action, "Changed description", context);
  assert.equal(retry.approvalId, pending.approvalId);
  assert.equal(retry.contextDigest, pending.contextDigest);
  assert.ok(gate.html().includes("https://example.com/article"));
  assert.equal(gate.html().includes("https://forged.example/"), false);
});

test("bounded observation evidence precedes large, explicitly truncated display details", () => {
  const gate = new ApprovalGate();
  const context = { actionDestination: { url: "https://example.org/destination" },
    recentPageObservations: Array.from({ length: 8 }, (_, index) => ({ url: `https://example.com/article-${index}/${"a".repeat(450)}` })),
    target: { fingerprint: "a".repeat(20_000) } };
  gate.prepare({ type: "click", target: context.target }, "Continue", context);
  const html = gate.html();
  assert.ok(html.includes("https://example.org/destination"));
  for (let index = 0; index < 8; index++) assert.ok(html.includes(`https://example.com/article-${index}/`));
  assert.ok(html.includes("Remaining display details truncated"));
});
