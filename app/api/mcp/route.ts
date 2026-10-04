import type { AuthInfo } from "@modelcontextprotocol/server";
import { timingSafeEqual } from "node:crypto";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { registerBrowserTools } from "@/lib/tools";
import { applyConfigEnvironment, loadConfig } from "@/companion/config";

export const runtime = "nodejs";
export const maxDuration = 60;

const handler = createMcpHandler((server) => registerBrowserTools(server));

async function verifyToken(_request: Request, bearerToken?: string): Promise<AuthInfo | undefined> {
  if (!bearerToken) return undefined;
  try {
    const settings = await loadConfig();
    const expected = Buffer.from(settings.token);
    const actual = Buffer.from(bearerToken);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;
    applyConfigEnvironment(settings);
    return { token: bearerToken, clientId: "local-client", scopes: ["browser:control"] };
  } catch {
    return undefined;
  }
}

const protectedHandler = withMcpAuth(handler, verifyToken, {
  required: true,
  requiredScopes: ["browser:control"],
});

function requestAllowed(request: Request): boolean {
  const host = request.headers.get("host") || "";
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(host)) return false;
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) &&
      parsed.host === host;
  } catch { return false; }
}

async function handle(request: Request) {
  if (!requestAllowed(request)) return new Response("Forbidden", { status: 403 });
  return protectedHandler(request);
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
