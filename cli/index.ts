#!/usr/bin/env node
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";
import { applyConfigEnvironment, loadConfig } from "../companion/config";
import { createBrowserPilotServer } from "../mcp/server";
import { companionHealth, ensureCompanion, spawnCompanion, stopOwnedCompanion } from "./runtime";

const help = `BrowserPilot 0.4.0\n\nCommands:\n  init [--port 8765] [--backend extension|playwright] [--headless] [--browser-path PATH]\n  pair       Print local extension pairing JSON (keep private)\n  start      Run the companion in the foreground\n  status     Check the configured local companion\n  mcp        Serve standard MCP over stdio; starts the companion if needed\n\nEnvironment: BROWSERPILOT_DATA_DIR, BROWSERPILOT_CONFIG_PATH.\nPlaywright backend: install Chromium once with npx playwright install chromium.\n`;

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  if (["help", "--help", "-h"].includes(command)) { process.stdout.write(help); return; }
  if (["--version", "version"].includes(command)) { process.stdout.write("0.4.0\n"); return; }
  const option = (name: string) => {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Missing value for ${name}.`);
    return args[index + 1];
  };
  if (!["init", "setup", "pair", "start", "status", "mcp"].includes(command)) throw new Error(`Unknown command: ${command}. Run browserpilot --help.`);
  const backend = option("--backend");
  if (backend && !["extension", "playwright"].includes(backend)) throw new Error("Backend must be extension or playwright.");
  const config = await loadConfig({ create: ["init", "setup", "mcp"].includes(command), defaults: {
    companionPort: option("--port") ? Number(option("--port")) : undefined,
    backend: backend as "extension" | "playwright" | undefined,
    headless: args.includes("--headless") ? true : undefined,
    executablePath: option("--browser-path"),
  } });
  applyConfigEnvironment(config);
  if (["init", "setup"].includes(command)) {
    process.stdout.write(`BrowserPilot configured at ${config.configPath}\nBackend: ${config.backend}; companion: http://127.0.0.1:${config.companionPort}\nRun browserpilot pair to pair your extension, then browserpilot mcp from an MCP client.\n`);
    return;
  }
  if (command === "pair") {
    const bridgeToken = createHmac("sha256", config.token).update("browserpilot-brave-extension-v1").digest("hex");
    process.stdout.write(`${JSON.stringify({ bridgePort: config.companionPort, bridgeToken })}\n`);
    return;
  }
  if (command === "status") {
    process.stdout.write(`${JSON.stringify(await companionHealth(config), null, 2)}\n`);
    return;
  }
  const entrypoint = fileURLToPath(new URL("../companion/server.js", import.meta.url));
  if (command === "start") {
    const child = spawnCompanion(entrypoint);
    process.once("SIGINT", () => { void stopOwnedCompanion(child); });
    process.once("SIGTERM", () => { void stopOwnedCompanion(child); });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => { if (code) process.exitCode = code; resolve(); });
    });
    return;
  }
  const ownedChild = await ensureCompanion(config, entrypoint);
  const transport = new StdioServerTransport();
  const handle = serveStdio(() => createBrowserPilotServer(), { transport,
    onerror: (error) => { process.stderr.write(`BrowserPilot MCP: ${error.message}\n`); },
  });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await handle.close();
    await stopOwnedCompanion(ownedChild);
  };
  const transportClose = transport.onclose;
  transport.onclose = () => { transportClose?.(); void close(); };
  process.once("SIGINT", () => { void close(); });
  process.once("SIGTERM", () => { void close(); });
}

main().catch((error) => {
  process.stderr.write(`BrowserPilot: ${error instanceof Error ? error.message : "Command failed"}\n`);
  process.exitCode = 1;
});
