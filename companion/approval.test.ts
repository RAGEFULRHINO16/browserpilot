import assert from "node:assert/strict";
import test from "node:test";
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
