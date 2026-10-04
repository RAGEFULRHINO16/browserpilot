import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

type PendingApproval = {
  id: string;
  digest: string;
  description: string;
  expiresAt: number;
  approved: boolean;
  context: string;
};

export function requiresActionApproval(input: { type: string; action?: string; request?: unknown }): boolean {
  if (["click", "download", "fill", "press", "upload"].includes(input.type)) return true;
  if (input.type === "interact") return input.action !== "hover";
  return input.type === "wait" && !!input.request && typeof input.request === "object" &&
    "trigger" in input.request && !!input.request.trigger;
}

export class ApprovalGate {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly csrf = randomBytes(32).toString("hex");

  constructor(private readonly approvalUrl = "http://127.0.0.1:8765/approvals") {}

  prepare(action: unknown, description: string, context: unknown = {}) {
    this.prune();
    const digest = this.digest(action);
    const existing = [...this.pending.values()].find((item) => item.digest === digest && !item.approved);
    if (existing) return this.result(existing);
    if (this.pending.size >= 128) throw new Error("Too many pending approvals. Complete or wait for existing approvals to expire.");
    const id = randomBytes(16).toString("hex");
    const approval: PendingApproval = {
      id,
      digest,
      description: description.slice(0, 240),
      expiresAt: Date.now() + 5 * 60_000,
      approved: false,
      context: JSON.stringify(context, null, 2).slice(0, 16_384),
    };
    this.pending.set(id, approval);
    return this.result(approval);
  }

  consume(id: string | undefined, action: unknown): boolean {
    if (!id) return false;
    this.prune();
    const approval = this.pending.get(id);
    if (!approval || !approval.approved || approval.digest !== this.digest(action)) return false;
    this.pending.delete(id);
    return true;
  }

  approve(id: string, csrf: string): boolean {
    this.prune();
    const approval = this.pending.get(id);
    const supplied = Buffer.from(csrf);
    const expected = Buffer.from(this.csrf);
    if (!approval || approval.approved || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return false;
    approval.approved = true;
    return true;
  }

  html(): string {
    this.prune();
    const rows = [...this.pending.values()].filter((item) => !item.approved).map((item) =>
      `<li><strong>${escapeHtml(item.description)}</strong><p>Request SHA-256: <code title="${item.digest}">${item.digest.slice(0, 12)}</code></p><pre>${escapeHtml(item.context)}</pre><form method="POST" action="/approvals/${item.id}"><input type="hidden" name="csrf" value="${this.csrf}"><button type="submit">Approve once</button></form></li>`
    ).join("");
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BrowserPilot approvals</title><style>body{font:16px system-ui;max-width:680px;margin:4rem auto;padding:0 1rem;background:#14191b;color:#f4f4ee}li{padding:1rem;border:1px solid #506057;margin:1rem 0;list-style:none}pre{white-space:pre-wrap;overflow-wrap:anywhere}button{margin-top:.75rem;padding:.7rem 1rem;cursor:pointer}</style></head><body><h1>BrowserPilot approvals</h1><p>Approve only actions you recognize in your current agent task. Websites may change between approval and execution.</p><ul>${rows || "<li>No pending actions.</li>"}</ul></body></html>`;
  }

  private result(approval: PendingApproval) {
    return { approvalRequired: true, approvalId: approval.id, description: approval.description,
      approvalUrl: this.approvalUrl, expiresAt: approval.expiresAt, requestDigest: approval.digest };
  }

  private digest(action: unknown): string {
    return createHash("sha256").update(JSON.stringify(action)).digest("hex");
  }

  private prune(): void {
    for (const [id, approval] of this.pending) {
      if (approval.expiresAt < Date.now()) this.pending.delete(id);
    }
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] || character);
}
