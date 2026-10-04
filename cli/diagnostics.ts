import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { loadConfig, type BrowserPilotConfig } from "../companion/config";
import { inspectCompanion, type CompanionInspection } from "./runtime";

type Check = { id: string; status: "pass" | "warn" | "fail"; message: string };
export type McpClient = "claude" | "codex" | "generic";
export interface DoctorReport {
  schemaVersion: 1;
  command: "doctor" | "status" | "setup";
  state: string;
  ok: boolean;
  summary: string;
  nodeVersion: string;
  configuration?: { backend: string; companionPort: number; configPath: string; dataDir: string;
    profileDir: string; downloadDir: string; uploadDir: string; headless: boolean; credentialsSource: string };
  companion?: CompanionInspection;
  checks: Check[];
  nextSteps: string[];
  mcp: { command: string; args: string[]; env?: Record<string, string> };
  client?: McpClient;
  clientConfiguration?: unknown;
}

export function clientConfiguration(client: McpClient, mcp: DoctorReport["mcp"]): unknown {
  if (client === "claude") return { mcpServers: { browserpilot: mcp } };
  if (client === "codex") return ["[mcp_servers.browserpilot]", `command = ${JSON.stringify(mcp.command)}`,
    `args = ${JSON.stringify(mcp.args)}`, ...(mcp.env ? ["", "[mcp_servers.browserpilot.env]",
      ...Object.entries(mcp.env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`)] : []), ""].join("\n");
  return mcp;
}

export function setupSteps(config: BrowserPilotConfig, extensionDirectory: string): string[] {
  if (config.backend === "playwright") return [
    config.executablePath ? "Check that the configured browser executable is installed and usable." : "Install Chromium once with npx playwright install chromium.",
    "Add the displayed command and arguments to your MCP client. The client starts the companion automatically.",
    "Complete website sign-in directly in BrowserPilot's dedicated browser profile; use human takeover for security prompts.",
    "Run browserpilot doctor after connecting to check browser readiness.",
  ];
  return [
    `Open brave://extensions or chrome://extensions, enable Developer mode, choose Load unpacked, and select ${extensionDirectory}.`,
    "Run browserpilot pair. Paste its private JSON into the extension popup's Local pairing code field, choose a profile name, and click Save and connect.",
    "In the popup, approve each website you want the agent to use. Start with https://example.com for a simple browser_open test.",
    "Add the displayed command and arguments to your MCP client. It starts the companion automatically; keep your browser open.",
    "Run browserpilot doctor after connecting. If the extension was updated, reload it in the browser's extensions page and reconnect.",
  ];
}

export async function doctorReport(options: { command: DoctorReport["command"]; entrypoint: string; extensionDirectory: string;
  config?: BrowserPilotConfig; timeoutMs?: number }): Promise<DoctorReport> {
  const checks: Check[] = [];
  const report: DoctorReport = { schemaVersion: 1, command: options.command, state: "configuration_missing", ok: false,
    summary: "BrowserPilot needs local setup.", nodeVersion: process.versions.node, checks, nextSteps: [],
    mcp: { command: process.execPath, args: [options.entrypoint, "mcp"] } };
  checks.push({ id: "node", status: Number(process.versions.node.split(".")[0]) >= 22 ? "pass" : "fail",
    message: "BrowserPilot requires Node.js 22 or later." });
  let config: BrowserPilotConfig;
  try { config = options.config || await loadConfig(); }
  catch (error) {
    const missing = error instanceof Error && error.message.includes("not configured");
    report.state = missing ? "configuration_missing" : "configuration_invalid";
    report.summary = missing ? "BrowserPilot has no local configuration yet." : "BrowserPilot could not load a valid local configuration.";
    checks.push({ id: "configuration", status: "fail", message: report.summary });
    report.nextSteps = missing ? ["Run browserpilot setup to create local credentials and see the connection steps."] : [
      "Check BROWSERPILOT_CONFIG_PATH and the local config.json. Restore or correct its token, port and backend settings; keep its token private.",
      "Use a new BROWSERPILOT_DATA_DIR with browserpilot setup if you need a separate configuration, then pair that configuration with your extension.",
    ];
    return report;
  }
  report.configuration = { backend: config.backend, companionPort: config.companionPort, configPath: config.configPath,
    dataDir: config.dataDir, profileDir: config.profileDir, downloadDir: config.downloadDir, uploadDir: config.uploadDir,
    headless: config.headless, credentialsSource: process.env.BROWSERPILOT_COMPANION_TOKEN ? "environment" : "local_config" };
  report.mcp.env = { BROWSERPILOT_CONFIG_PATH: config.configPath, BROWSERPILOT_DATA_DIR: config.dataDir,
    BROWSERPILOT_BROWSER_BACKEND: config.backend, BROWSERPILOT_COMPANION_PORT: String(config.companionPort),
    BROWSERPILOT_HEADLESS: config.headless ? "1" : "0", BROWSERPILOT_PROFILE_DIR: config.profileDir,
    BROWSERPILOT_DOWNLOAD_DIR: config.downloadDir, BROWSERPILOT_UPLOAD_DIR: config.uploadDir,
    ...(config.executablePath ? { BROWSERPILOT_CHROME_PATH: config.executablePath } : {}) };
  checks.push({ id: "configuration", status: "pass", message: `Local configuration is valid: ${config.configPath}` });
  if (process.env.BROWSERPILOT_COMPANION_TOKEN) {
    checks.push({ id: "environment_credentials", status: "warn",
      message: "Credentials were supplied through the environment. Configure the MCP client to inherit that private environment; diagnostics do not export credentials." });
  }
  if (process.platform !== "win32") {
    try {
      const mode = (await stat(config.configPath)).mode & 0o777;
      checks.push({ id: "config_permissions", status: (mode & 0o077) === 0 ? "pass" : "warn",
        message: (mode & 0o077) === 0 ? "The local credential file is accessible only to its owner." : "Restrict the local credential file to its owner with chmod 600 before sharing this machine." });
    } catch { /* Environment-only credentials need no config file. */ }
  }
  if (options.command !== "status") {
    if (config.backend === "extension") {
      try {
        await access(options.extensionDirectory, constants.R_OK);
        checks.push({ id: "extension_files", status: "pass", message: `Unpacked extension: ${options.extensionDirectory}` });
      } catch {
        checks.push({ id: "extension_files", status: "fail", message: "Extension files are missing. Reinstall or rebuild the BrowserPilot release before loading the unpacked extension." });
      }
    } else {
      let executable = config.executablePath;
      if (!executable) {
        try { executable = (await import("playwright")).chromium.executablePath(); } catch { /* Installation check below reports this. */ }
      }
      try {
        if (!executable) throw new Error("Missing browser.");
        await access(executable, process.platform === "win32" ? constants.R_OK : constants.R_OK | constants.X_OK);
        checks.push({ id: "browser_executable", status: "pass", message: "The configured browser executable is available." });
      } catch {
        checks.push({ id: "browser_executable", status: "fail", message: config.executablePath ?
          "The configured browser executable is unavailable. Correct BROWSERPILOT_CHROME_PATH or install that browser." :
          "Playwright Chromium is missing. Run npx playwright install chromium." });
      }
    }
  }
  const companion = await inspectCompanion(config, options.timeoutMs);
  report.companion = companion;
  report.state = companion.state;
  report.summary = companion.summary;
  const running = ["healthy", "browser_not_ready"].includes(companion.state);
  checks.push({ id: "companion", status: running ? "pass" : companion.state === "offline" ? "warn" : "fail",
    message: running ? "The authenticated companion is running with the configured backend." : companion.summary });
  if (running) {
    checks.push({ id: "browser_connection", status: companion.state === "healthy" ? "pass" : "warn",
      message: companion.state === "healthy" ? "The selected browser backend is connected." : companion.summary });
    if (config.backend === "extension") {
      const profiles = companion.health?.connectedProfiles || companion.health?.connectedBraveProfiles || [];
      checks.push({ id: "extension_profiles", status: profiles.length ? "pass" : "warn",
        message: profiles.length ? `Connected browser profiles: ${profiles.join(", ")}.` : "No paired browser profiles are connected. Open the browser and check Local pairing code in the extension popup." });
    }
    if (companion.health?.memory) {
      const memory = companion.health.memory;
      checks.push({ id: "companion_memory", status: "pass",
        message: `Companion memory: ${(memory.rssBytes / 1048576).toFixed(1)} MiB RSS; ${(memory.heapUsedBytes / 1048576).toFixed(1)} MiB JavaScript heap.` });
    }
    if (companion.health?.workflows && (!companion.health.workflows.catalogReady || !companion.health.workflows.replayReady || companion.health.workflows.warningCount)) {
      checks.push({ id: "workflow_recovery", status: "warn", message: "Saved workflows need attention. Use browser_workflow_status before continuing a replay; inspect local diagnostics if the catalog is unavailable." });
    }
    if (companion.health?.handedOff) {
      report.state = "human_takeover";
      report.summary = "BrowserPilot is connected and paused for human takeover.";
      checks.push({ id: "human_takeover", status: "warn", message: "Complete the browser step yourself, then use browser_resume in the MCP client." });
    }
  }
  report.ok = companion.state === "healthy" && !companion.health?.handedOff && checks.every((check) => check.status !== "fail");
  if (["auth_conflict", "backend_mismatch", "invalid_response", "unresponsive", "service_error"].includes(companion.state)) {
    report.nextSteps = [companion.summary,
      "Run the service from its original terminal or configuration to inspect it. BrowserPilot will not replace or stop a process started elsewhere.",
      "For a separate installation, set a new BROWSERPILOT_DATA_DIR and run browserpilot setup --port with an unused port."];
  } else if (companion.state === "offline" || companion.state === "browser_not_ready") {
    report.nextSteps = setupSteps(config, options.extensionDirectory);
  } else if (companion.health?.handedOff) {
    report.nextSteps = ["Finish the human takeover step in your browser, then call browser_resume from the MCP client. No extra companion needs to be started."];
  } else {
    report.nextSteps = ["Use browser_status from your MCP client, then browser_open with an approved website. Per-site access and local action approvals still apply."];
  }
  return report;
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [report.summary];
  if (report.configuration) lines.push(`Backend: ${report.configuration.backend}; local port: ${report.configuration.companionPort}`);
  lines.push(...report.checks.map((check) => `[${check.status.toUpperCase()}] ${check.message}`));
  if (report.nextSteps.length) lines.push("", ...report.nextSteps.map((step, index) => `${index + 1}. ${step}`));
  const client = report.clientConfiguration || report.mcp;
  lines.push("", `MCP client configuration${report.client ? ` (${report.client})` : ""}:`,
    typeof client === "string" ? client.trimEnd() : JSON.stringify(client, null, 2));
  return `${lines.join("\n")}\n`;
}
