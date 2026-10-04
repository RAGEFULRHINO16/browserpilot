import { spawn, type ChildProcess } from "node:child_process";
import type { BrowserPilotConfig } from "../companion/config";

export interface CompanionHealth {
  ready: boolean;
  serviceReady?: boolean;
  backend: "extension" | "playwright";
  connectedBraveProfiles?: string[];
  connectedProfiles?: string[];
  profileId?: string;
  handedOff?: boolean;
  memory?: { rssBytes: number; heapUsedBytes: number };
  uptimeSeconds?: number;
  queueDepth?: number;
  workflows?: { catalogReady: boolean; replayReady: boolean; warningCount: number };
}
export type CompanionState = "healthy" | "browser_not_ready" | "offline" | "auth_conflict" |
  "backend_mismatch" | "unresponsive" | "invalid_response" | "service_error";
export interface CompanionInspection {
  state: CompanionState;
  summary: string;
  health?: CompanionHealth;
  httpStatus?: number;
}

function safeHealth(value: unknown): CompanionHealth | undefined {
  if (!value || typeof value !== "object") return undefined;
  const health = value as Record<string, unknown>;
  if (typeof health.ready !== "boolean" || !["extension", "playwright"].includes(String(health.backend))) return undefined;
  const profiles = (value: unknown) => Array.isArray(value) && value.length <= 32 &&
    value.every((id) => typeof id === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(id)) ? value as string[] : undefined;
  const memory = health.memory as Record<string, unknown> | undefined;
  const workflow = health.workflows as Record<string, unknown> | undefined;
  const positiveInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
  return { ready: health.ready, backend: health.backend as CompanionHealth["backend"],
    ...(typeof health.serviceReady === "boolean" ? { serviceReady: health.serviceReady } : {}),
    ...(profiles(health.connectedBraveProfiles) ? { connectedBraveProfiles: profiles(health.connectedBraveProfiles) } : {}),
    ...(profiles(health.connectedProfiles) ? { connectedProfiles: profiles(health.connectedProfiles) } : {}),
    ...(typeof health.profileId === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(health.profileId) ? { profileId: health.profileId } : {}),
    ...(typeof health.handedOff === "boolean" ? { handedOff: health.handedOff } : {}),
    ...(memory && positiveInteger(memory.rssBytes) && positiveInteger(memory.heapUsedBytes) ?
      { memory: { rssBytes: memory.rssBytes, heapUsedBytes: memory.heapUsedBytes } } : {}),
    ...(typeof health.uptimeSeconds === "number" && Number.isFinite(health.uptimeSeconds) && health.uptimeSeconds >= 0 ? { uptimeSeconds: health.uptimeSeconds } : {}),
    ...(typeof health.queueDepth === "number" && Number.isInteger(health.queueDepth) && health.queueDepth >= 0 && health.queueDepth <= 16 ? { queueDepth: health.queueDepth } : {}),
    ...(workflow && typeof workflow.catalogReady === "boolean" && typeof workflow.replayReady === "boolean" ?
      { workflows: { catalogReady: workflow.catalogReady, replayReady: workflow.replayReady,
        warningCount: Array.isArray(workflow.warnings) ? workflow.warnings.length : 0 } } : {}),
  };
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body || Number(response.headers.get("content-length") || 0) > 16_384) throw new Error("Invalid health response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16_384) { await reader.cancel(); throw new Error("Invalid health response."); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { reader.releaseLock(); }
}

export async function inspectCompanion(config: BrowserPilotConfig, timeoutMs = 1500): Promise<CompanionInspection> {
  const endpoint = `http://127.0.0.1:${config.companionPort}`;
  try {
    const response = await fetch(`${endpoint}/health`, {
      headers: { authorization: `Bearer ${config.token}` }, redirect: "error",
      signal: AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, 20_000))),
    });
    if ([401, 403].includes(response.status)) return { state: "auth_conflict", httpStatus: response.status,
      summary: `The service on port ${config.companionPort} rejected this configuration's credentials. Check which BrowserPilot configuration started it, or choose a separate configuration and port.` };
    if (!response.ok) return { state: "service_error", httpStatus: response.status,
      summary: `The service on port ${config.companionPort} returned HTTP ${response.status}. Resolve that service's error before starting another companion.` };
    let health: CompanionHealth | undefined;
    try { health = safeHealth(await boundedJson(response)); }
    catch (error) {
      if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) throw error;
    }
    if (!health) return { state: "invalid_response",
      summary: `Port ${config.companionPort} answered, but it did not return a valid BrowserPilot health response. Check the service using that port.` };
    if (health.backend !== config.backend) return { state: "backend_mismatch", health,
      summary: `The running companion uses ${health.backend}, while this configuration selects ${config.backend}. Use the matching configuration or stop the other companion yourself before changing backends.` };
    const connected = health.connectedProfiles || health.connectedBraveProfiles;
    const browserReady = health.ready && !(health.backend === "extension" && connected && !connected.length);
    return browserReady ? { state: "healthy", health, summary: `BrowserPilot is running with the ${health.backend} backend.` } :
      { state: "browser_not_ready", health, summary: health.backend === "extension" ?
        "The companion is running, but its selected browser profile is not connected. Open your browser and check the extension pairing." :
        "The companion is running, but the browser backend is not ready. Check the browser executable and profile, then retry the agent action." };
  } catch (error) {
    if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) return { state: "unresponsive",
      summary: `The service on port ${config.companionPort} did not answer within the health-check timeout. Inspect its terminal or logs and retry; another companion will not be started on this port.` };
    const cause = error instanceof Error ? error.cause as { code?: string } | undefined : undefined;
    if (cause?.code === "ECONNREFUSED") return { state: "offline",
      summary: `The local companion is stopped. Start it with browserpilot start, or let your MCP client run browserpilot mcp.` };
    return { state: "service_error", summary: `Cannot reach the service on port ${config.companionPort}. Check the local port and firewall configuration.` };
  }
}

export class CompanionRuntimeError extends Error {
  constructor(readonly inspection: CompanionInspection) { super(inspection.summary); this.name = "CompanionRuntimeError"; }
}

export async function companionHealth(config: BrowserPilotConfig): Promise<CompanionHealth> {
  const inspection = await inspectCompanion(config);
  if (["healthy", "browser_not_ready"].includes(inspection.state) && inspection.health) return inspection.health;
  throw new CompanionRuntimeError(inspection);
}

export function spawnCompanion(entrypoint: string): ChildProcess {
  const child = spawn(process.execPath, [entrypoint], { env: process.env, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
  child.stdout?.pipe(process.stderr);
  child.stderr?.pipe(process.stderr);
  return child;
}

export async function ensureCompanion(config: BrowserPilotConfig, entrypoint: string,
  options: { timeoutMs?: number; pollIntervalMs?: number; signal?: AbortSignal; spawn?: (entrypoint: string) => ChildProcess } = {},
): Promise<ChildProcess | undefined> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) throw new Error("Startup timeout must be between 100 and 60000 milliseconds.");
  const deadline = Date.now() + timeoutMs;
  if (options.signal?.aborted) throw new Error("Companion startup was cancelled.");
  const initial = await inspectCompanion(config, Math.min(1500, timeoutMs));
  if (["healthy", "browser_not_ready"].includes(initial.state)) return undefined;
  if (initial.state !== "offline") throw new CompanionRuntimeError(initial);
  if (options.signal?.aborted) throw new Error("Companion startup was cancelled.");
  const child = (options.spawn || spawnCompanion)(entrypoint);
  let spawnError: Error | undefined;
  child.once("error", (error) => { spawnError = error; });
  try {
    while (Date.now() < deadline) {
      if (options.signal?.aborted) throw new Error("Companion startup was cancelled.");
      if (spawnError) throw new Error("The companion process could not be launched. Check the Node executable and installation.");
      const inspection = await inspectCompanion(config, Math.min(1500, Math.max(1, deadline - Date.now())));
      if (["healthy", "browser_not_ready"].includes(inspection.state)) {
        return child.exitCode === null && child.signalCode === null ? child : undefined;
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`The companion exited during startup (code ${child.exitCode ?? "none"}, signal ${child.signalCode ?? "none"}). Check its diagnostics above; run browserpilot doctor for recovery steps.`);
      }
      if (inspection.state !== "offline") throw new CompanionRuntimeError(inspection);
      await new Promise((resolve) => setTimeout(resolve, Math.min(options.pollIntervalMs ?? 150, Math.max(1, deadline - Date.now()))));
    }
    throw new Error(`The companion did not start within ${timeoutMs} milliseconds. Run browserpilot doctor and check the browser installation or port.`);
  } catch (error) {
    await stopOwnedCompanion(child);
    throw error;
  }
}

export async function stopOwnedCompanion(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    // Windows kill(SIGTERM) is forceful; parent-only IPC allows profile closure first.
    if (child.connected) {
      try { child.send({ type: "browserpilot-shutdown" }, (error) => { if (error) child.kill("SIGTERM"); }); }
      catch { child.kill("SIGTERM"); }
    } else child.kill("SIGTERM");
  });
}

export class ManagedCompanion {
  private owned: ChildProcess | undefined;
  private starting: Promise<void> | undefined;
  private closed = false;

  constructor(private readonly config: BrowserPilotConfig, private readonly entrypoint: string,
    private readonly options: Parameters<typeof ensureCompanion>[2] = {}) {}

  get ownedProcessId(): number | undefined { return this.owned?.pid; }

  async ensureRunning(): Promise<void> {
    if (this.closed) throw new Error("The MCP companion session is closed.");
    if (this.owned && this.owned.exitCode === null && this.owned.signalCode === null) return;
    if (!this.starting) {
      this.starting = (async () => {
        const owned = await ensureCompanion(this.config, this.entrypoint, this.options);
        if (this.closed) { await stopOwnedCompanion(owned); return; }
        this.owned = owned;
      })().finally(() => { this.starting = undefined; });
    }
    await this.starting;
    if (this.closed) throw new Error("The MCP companion session is closed.");
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.starting?.catch(() => undefined);
    const owned = this.owned;
    this.owned = undefined;
    await stopOwnedCompanion(owned);
  }
}
