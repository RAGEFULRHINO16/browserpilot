#!/usr/bin/env node
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";
import { applyConfigEnvironment, loadConfig } from "../companion/config";
import { callCompanion } from "../lib/companion";
import { createBrowserPilotServer } from "../mcp/server";
import { clientConfiguration, doctorReport, formatDoctorReport, setupSteps, type McpClient } from "./diagnostics";
import { ensureCompanion, inspectCompanion, ManagedCompanion, stopOwnedCompanion } from "./runtime";

const help = `BrowserPilot 0.5.0

Commands:
  setup [--port 8765] [--backend extension|playwright] [--headless] [--browser-path PATH] [--client claude|codex|generic] [--json]
  init       Alias for setup; existing credentials and settings are preserved
  doctor     Diagnose configuration, companion and browser connection [--json] [--timeout-ms 1500]
  status     Check the configured local companion [--json]
  pair       Print private extension pairing JSON for the browser popup
  start      Run the companion in the foreground, or report an existing service
  mcp        Serve standard MCP over stdio; starts and recovers its companion when needed

start and mcp accept --startup-timeout-ms (100..60000; default 20000).
Environment: BROWSERPILOT_DATA_DIR, BROWSERPILOT_CONFIG_PATH.
Playwright backend: install Chromium once with npx playwright install chromium.
Use npm ci --workspaces=false for stdio-only installs; add the optional HTTP adapter separately.
`;

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  if (["help", "--help", "-h"].includes(command)) { process.stdout.write(help); return; }
  if (["--version", "version"].includes(command)) { process.stdout.write("0.5.0\n"); return; }
  if (!["init", "setup", "doctor", "pair", "start", "status", "mcp"].includes(command)) throw new Error(`Unknown command: ${command}. Run browserpilot --help.`);
  const valueFlags = ["--port", "--backend", "--browser-path", "--startup-timeout-ms", "--timeout-ms", "--client"];
  const booleanFlags = ["--headless", "--json"];
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (booleanFlags.includes(flag)) continue;
    if (!valueFlags.includes(flag)) throw new Error(`Unknown option: ${flag}.`);
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}.`);
    values.set(flag, value);
  }
  const option = (name: string) => values.get(name);
  const json = args.includes("--json");
  const client = (option("--client") || "generic") as McpClient;
  if (!["claude", "codex", "generic"].includes(client)) throw new Error("Client must be claude, codex, or generic.");
  const cliEntrypoint = fileURLToPath(import.meta.url);
  const extensionDirectory = fileURLToPath(new URL("../../extension/", import.meta.url));
  if (["doctor", "status"].includes(command)) {
    const timeoutMs = option("--timeout-ms") === undefined ? undefined : Number(option("--timeout-ms"));
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 20_000)) throw new Error("Health timeout must be between 1 and 20000 milliseconds.");
    const report = await doctorReport({ command: command as "doctor" | "status", entrypoint: cliEntrypoint, extensionDirectory, timeoutMs });
    report.client = client;
    report.clientConfiguration = clientConfiguration(client, report.mcp);
    process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : formatDoctorReport(report));
    process.exitCode = report.ok ? 0 : 1;
    return;
  }
  const backend = option("--backend");
  if (backend && !["extension", "playwright"].includes(backend)) throw new Error("Backend must be extension or playwright.");
  const config = await loadConfig({ create: ["init", "setup", "mcp"].includes(command), defaults: {
    companionPort: option("--port") ? Number(option("--port")) : undefined,
    backend: backend as "extension" | "playwright" | undefined,
    headless: args.includes("--headless") ? true : undefined,
    executablePath: option("--browser-path"),
  } });
  if (["init", "setup"].includes(command)) {
    const report = await doctorReport({ command: "setup", entrypoint: cliEntrypoint, extensionDirectory, config });
    const result = { ...report, state: "configured", configured: true, ok: true,
      client, clientConfiguration: clientConfiguration(client, report.mcp),
      companionState: report.state, summary: `BrowserPilot configured at ${config.configPath}`,
      nextSteps: setupSteps(config, extensionDirectory) };
    if (option("--port") && Number(option("--port")) !== config.companionPort) {
      result.nextSteps.unshift(`Existing settings preserved port ${config.companionPort}; --port selects the port only for a new configuration. Use a separate BROWSERPILOT_DATA_DIR to create another installation.`);
    }
    process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : formatDoctorReport(result));
    return;
  }
  applyConfigEnvironment(config);
  if (command === "pair") {
    const bridgeToken = createHmac("sha256", config.token).update("browserpilot-brave-extension-v1").digest("hex");
    process.stdout.write(`${JSON.stringify({ bridgePort: config.companionPort, bridgeToken })}\n`);
    return;
  }
  const entrypoint = fileURLToPath(new URL("../companion/server.js", import.meta.url));
  const timeoutMs = option("--startup-timeout-ms") === undefined ? undefined : Number(option("--startup-timeout-ms"));
  const startup = new AbortController();
  if (command === "start") {
    let child: Awaited<ReturnType<typeof ensureCompanion>>;
    const interrupted = () => { startup.abort(); void stopOwnedCompanion(child); };
    process.once("SIGINT", interrupted);
    process.once("SIGTERM", interrupted);
    try {
      child = await ensureCompanion(config, entrypoint, { timeoutMs, signal: startup.signal });
      const inspection = await inspectCompanion(config);
      process.stdout.write(json ? `${JSON.stringify({ started: !!child, ...inspection })}\n` : `${inspection.summary}\n`);
      if (!child) return;
      if (child.exitCode !== null || child.signalCode !== null) { process.exitCode = child.exitCode || 0; return; }
      await new Promise<void>((resolve, reject) => {
        child!.once("error", reject);
        child!.once("exit", (code) => { if (code) process.exitCode = code; resolve(); });
      });
    } finally {
      process.removeListener("SIGINT", interrupted);
      process.removeListener("SIGTERM", interrupted);
      await stopOwnedCompanion(child);
    }
    return;
  }
  const companion = new ManagedCompanion(config, entrypoint, { timeoutMs, signal: startup.signal });
  let closeSession: (() => Promise<void>) | undefined;
  const interrupted = () => { startup.abort(); if (closeSession) void closeSession(); };
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  try {
    await companion.ensureRunning();
    const transport = new StdioServerTransport();
    const handle = serveStdio(() => createBrowserPilotServer(async (action) => {
      await companion.ensureRunning();
      return callCompanion(action);
    }), { transport, onerror: (error) => { process.stderr.write(`BrowserPilot MCP: ${error.message}\n`); } });
    let closing = false;
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    closeSession = async () => {
      if (closing) return;
      closing = true;
      startup.abort();
      try { await handle.close(); }
      finally { await companion.close(); finish(); }
    };
    const transportClose = transport.onclose;
    transport.onclose = () => { transportClose?.(); void closeSession!(); };
    await finished;
  } finally {
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
    await companion.close();
  }
}

main().catch((error) => {
  const summary = error instanceof Error ? error.message : "Command failed";
  if (process.argv.includes("--json") && process.argv[2] !== "mcp") {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, command: process.argv[2], state: "command_error", ok: false, summary })}\n`);
  } else process.stderr.write(`BrowserPilot: ${summary}\n`);
  process.exitCode = 1;
});
