import { spawn, type ChildProcess } from "node:child_process";
import type { BrowserPilotConfig } from "../companion/config";

export async function companionHealth(config: BrowserPilotConfig): Promise<{ ready: boolean; backend: string; connectedBraveProfiles?: string[] }> {
  const response = await fetch(`http://127.0.0.1:${config.companionPort}/health`, {
    headers: { authorization: `Bearer ${config.token}` }, redirect: "error", signal: AbortSignal.timeout(1500),
  });
  if (!response.ok) throw new Error(`Companion health returned ${response.status}; the port may belong to another configuration.`);
  return response.json();
}

export function spawnCompanion(entrypoint: string): ChildProcess {
  const child = spawn(process.execPath, [entrypoint], { env: process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout?.pipe(process.stderr);
  child.stderr?.pipe(process.stderr);
  return child;
}

export async function ensureCompanion(config: BrowserPilotConfig, entrypoint: string): Promise<ChildProcess | undefined> {
  try {
    const health = await companionHealth(config);
    if (health.ready && health.backend === config.backend) return undefined;
    throw new Error("A companion with a different browser backend is already running.");
  } catch (error) {
    if (!(error instanceof TypeError) && !(error instanceof Error && error.name === "TimeoutError")) throw error;
  }
  const child = spawnCompanion(entrypoint);
  let spawnError: Error | undefined;
  child.once("error", (error) => { spawnError = error; });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`BrowserPilot companion exited with code ${child.exitCode}.`);
    try {
      if ((await companionHealth(config)).ready) return child;
    } catch { /* The listener may not be ready during startup. */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  child.kill();
  throw new Error("BrowserPilot companion did not become ready within 20 seconds.");
}

export async function stopOwnedCompanion(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 3000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}
