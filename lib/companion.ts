export type BrowserAction = { type: string; [key: string]: unknown };

export async function callCompanion(action: BrowserAction): Promise<unknown> {
  const base = process.env.BROWSERPILOT_COMPANION_URL;
  const token = process.env.BROWSERPILOT_COMPANION_TOKEN;
  if (!base || !token) throw new Error("The browser companion is not configured.");
  const endpoint = new URL("/action", base);
  const localHttp = endpoint.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname);
  if (endpoint.username || endpoint.password ||
      (process.env.NODE_ENV === "production" && endpoint.protocol !== "https:" && !localHttp)) {
    throw new Error("Production companion connections require HTTPS or local loopback without embedded credentials.");
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(action),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(45_000),
  });

  const payload = await response.json() as { result?: unknown; error?: string };
  if (!response.ok) throw new Error(payload.error || `Browser companion returned ${response.status}.`);
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
