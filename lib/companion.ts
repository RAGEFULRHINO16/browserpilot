export type BrowserAction = { type: string; [key: string]: unknown };

const readActions = new Set(["status", "snapshot", "tabs", "profiles", "find", "extract", "diagnostics", "site_extract", "list_downloads", "read_file", "workflow_list", "workflow_status"]);

export class CompanionError extends Error {
  constructor(message: string, readonly code: string, readonly recovery: string[], readonly outcomeUnknown = false,
    readonly retryable = false) { super(message); this.name = "CompanionError"; }
}

export function browserFailure(error: unknown, action: BrowserAction): CompanionError {
  if (error instanceof CompanionError) return error;
  const message = error instanceof Error ? error.message : "Browser action failed.";
  const readOnly = readActions.has(action.type);
  if (/page id is stale|page.*not found|unknown page/i.test(message)) {
    return new CompanionError(message, "STALE_PAGE", ["Call browser_tabs, select the intended page ID, then take a fresh browser_snapshot. Prefer browser_find semantic targets." ]);
  }
  if (/paused for human takeover/i.test(message)) return new CompanionError(message, "HUMAN_TAKEOVER", ["Complete the browser security step yourself, then call browser_resume."]);
  if (/sensitive sign.in and payment|password fields/i.test(message)) return new CompanionError(message, "HUMAN_REQUIRED", ["Enter passwords, MFA and payment credentials directly in your browser."]);
  if (/approved website|cannot be controlled|unapproved website/i.test(message)) return new CompanionError(message, "SITE_PERMISSION", ["Approve only the intended public website in the BrowserPilot extension popup."]);
  if (/not connected|disconnected|connection replaced/i.test(message)) return new CompanionError(message, "BROWSER_DISCONNECTED", ["Keep the browser open. Check the extension popup and run browserpilot doctor.", "Inspect the page before retrying a write; the action may have completed."], !readOnly, readOnly);
  if (/timed out|timeout|expired/i.test(message)) return new CompanionError(message, "ACTION_TIMEOUT", ["Inspect the page and take a fresh snapshot before retrying. Never blindly repeat a message, purchase or deletion."], !readOnly, readOnly);
  return new CompanionError(message, "ACTION_FAILED", ["Run browserpilot doctor. Inspect the current page and diagnostics before retrying."], !readOnly);
}

export async function callCompanion(action: BrowserAction): Promise<unknown> {
  const base = process.env.BROWSERPILOT_COMPANION_URL;
  const token = process.env.BROWSERPILOT_COMPANION_TOKEN;
  if (!base || !token) throw new CompanionError("The browser companion is not configured.", "NOT_CONFIGURED", ["Run browserpilot setup, pair the extension, then connect your MCP client."]);
  const endpoint = new URL("/action", base);
  const localHttp = endpoint.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname);
  if (endpoint.username || endpoint.password ||
      (process.env.NODE_ENV === "production" && endpoint.protocol !== "https:" && !localHttp)) {
    throw new Error("Production companion connections require HTTPS or local loopback without embedded credentials.");
  }

  let response: Response;
  try { response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(action),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(45_000),
  }); } catch (error) {
    const cause = error instanceof Error ? (error.cause as { code?: string } | undefined)?.code : undefined;
    if (cause === "ECONNREFUSED") throw new CompanionError("The local companion is offline.", "COMPANION_OFFLINE", ["Start your MCP client or browserpilot start; run browserpilot doctor for diagnosis."], false, readActions.has(action.type));
    if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) throw browserFailure(new Error("Companion request timed out. The action may have completed."), action);
    throw browserFailure(error, action);
  }

  if (response.status === 401 || response.status === 403) throw new CompanionError("The companion rejected this connection. Do not start a second process on the same port.", "AUTHENTICATION_FAILED", ["Run browserpilot doctor; ensure the MCP client and companion use the same private configuration."]);
  if (response.status === 429) throw new CompanionError("The browser action queue is full. No action was started.", "QUEUE_FULL", ["Wait for the active action to finish before submitting another request."], false, readActions.has(action.type));
  let payload: { result?: unknown; error?: string };
  try { payload = await response.json(); }
  catch { throw new CompanionError("The companion returned an invalid response.", "INVALID_RESPONSE", ["Run browserpilot doctor and inspect the page before retrying."], !readActions.has(action.type)); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new CompanionError("The companion returned an invalid response.", "INVALID_RESPONSE", ["Run browserpilot doctor and inspect the page before retrying."], !readActions.has(action.type));
  if (!response.ok) throw browserFailure(new Error(typeof payload.error === "string" ? payload.error : `Browser companion returned ${response.status}.`), action);
  return payload.result;
}

export function toolResult(result: unknown) {
  if (result && typeof result === "object" && "snapshot" in result && "frames" in result && Array.isArray(result.frames)) {
    const observed = result as { snapshot: unknown; mediaBefore: unknown; mediaAfter: unknown;
      visualChangeDetected: boolean; truncated: boolean; frames: Array<{ offsetMs: number; mimeType: string; data: string }> };
    const metadata = { snapshot: observed.snapshot, mediaBefore: observed.mediaBefore, mediaAfter: observed.mediaAfter,
      visualChangeDetected: observed.visualChangeDetected, truncated: observed.truncated,
      frames: observed.frames.map((frame) => ({ offsetMs: frame.offsetMs, mimeType: frame.mimeType })) };
    return { structuredContent: metadata, content: [
      { type: "text" as const, text: JSON.stringify(metadata) },
      ...observed.frames.flatMap((frame, index) => [
        { type: "text" as const, text: `Frame ${index + 1} at ${frame.offsetMs} ms` },
        { type: "image" as const, mimeType: frame.mimeType, data: frame.data },
      ]),
    ] };
  }
  if (result && typeof result === "object" && "snapshot" in result && "mimeType" in result && "data" in result) {
    const visual = result as { snapshot: unknown; mimeType: string; data: string };
    return {
      structuredContent: { snapshot: visual.snapshot },
      content: [
        { type: "text" as const, text: JSON.stringify(visual.snapshot) },
        { type: "image" as const, mimeType: visual.mimeType, data: visual.data },
      ],
    };
  }
  if (result && typeof result === "object" && "mimeType" in result && "data" in result) {
    const file = result as { id?: string; name?: string; mimeType: string; data: string };
    if (file.mimeType.startsWith("image/") && file.mimeType !== "image/svg+xml") {
      return { content: [{ type: "image" as const, mimeType: file.mimeType, data: file.data }] };
    }
    return {
      content: [{ type: "resource" as const, resource: {
        uri: `browserpilot://file/${file.id || "artifact"}`,
        mimeType: file.mimeType,
        blob: file.data,
      } }],
      structuredContent: { id: file.id, name: file.name, mimeType: file.mimeType },
    };
  }
  return {
    structuredContent: { result },
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
  };
}
