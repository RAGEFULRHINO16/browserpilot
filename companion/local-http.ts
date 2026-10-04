import type { IncomingMessage } from "node:http";

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function localRequestAllowed(request: Pick<IncomingMessage, "headers">, port: number, options: { extensionOrigin?: boolean; requireOrigin?: boolean } = {}): boolean {
  const host = request.headers.host;
  if (!host) return false;
  let authority: URL;
  try {
    authority = new URL(`http://${host}`);
    if (!loopbackHosts.has(authority.hostname) || Number(authority.port || 80) !== port ||
        authority.username || authority.password || authority.pathname !== "/" || authority.search || authority.hash) return false;
  } catch { return false; }

  const origin = request.headers.origin;
  if (!origin) return !options.requireOrigin && !options.extensionOrigin;
  if (options.extensionOrigin) return /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
  try {
    const supplied = new URL(origin);
    return supplied.origin === authority.origin && origin === supplied.origin &&
      !["cross-site", "same-site"].includes(String(request.headers["sec-fetch-site"] || ""));
  } catch { return false; }
}
