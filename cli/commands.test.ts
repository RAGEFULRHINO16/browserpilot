import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function environment(root: string): Record<string, string> {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.startsWith("BROWSERPILOT_"))) as Record<string, string>,
    BROWSERPILOT_DATA_DIR: root, BROWSERPILOT_CONFIG_PATH: path.join(root, "config.json"),
    BROWSERPILOT_DOWNLOAD_DIR: path.join(root, "downloads"), BROWSERPILOT_UPLOAD_DIR: path.join(root, "uploads") };
}

async function run(args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [path.resolve("dist/cli/index.js"), ...args], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("CLI command timed out.")); }, 8000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

test("doctor is read-only before setup and machine output contains actionable recovery", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "browserpilot-doctor-"));
  try {
    const result = await run(["doctor", "--json"], environment(root));
    const report = JSON.parse(result.stdout);
    assert.equal(result.code, 1);
    assert.equal(report.state, "configuration_missing");
    assert.equal(report.ok, false);
    assert.match(report.nextSteps.join(" "), /browserpilot setup/);
    await assert.rejects(access(path.join(root, "config.json")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("guided setup preserves credentials and doctor never prints them", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "browserpilot-setup-"));
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  try {
    const env = environment(root);
    const setup = await run(["setup", "--port", String(address.port), "--json"], env);
    assert.equal(setup.code, 0);
    const saved = JSON.parse(await readFile(path.join(root, "config.json"), "utf8"));
    const report = JSON.parse(setup.stdout);
    assert.equal(report.configured, true);
    assert.match(report.nextSteps[0], /WARNING:.*real browser profile/);
    assert.match(report.nextSteps[0], /not a session sandbox/);
    assert.match(report.nextSteps.join(" "), /Save and connect/);
    assert.match(report.nextSteps.join(" "), /approve each website/);
    assert.equal(setup.stdout.includes(saved.token), false);
    assert.equal(JSON.stringify(report.mcp).includes("TOKEN"), false);
    const claude = await run(["setup", "--client", "claude", "--json"], env);
    const claudeConfiguration = JSON.parse(claude.stdout).clientConfiguration;
    assert.equal(claudeConfiguration.mcpServers.browserpilot.args.at(-1), "mcp");
    assert.equal(JSON.stringify(claudeConfiguration).includes(saved.token), false);
    const codex = await run(["setup", "--client", "codex", "--json"], env);
    const codexConfiguration = JSON.parse(codex.stdout).clientConfiguration;
    assert.match(codexConfiguration, /\[mcp_servers\.browserpilot\]/);
    assert.match(codexConfiguration, /\[mcp_servers\.browserpilot\.env\]/);
    assert.equal(codexConfiguration.includes(saved.token), false);
    const repeated = await run(["setup", "--port", String(address.port === 65535 ? 65534 : address.port + 1), "--json"], env);
    assert.equal(repeated.code, 0);
    assert.equal(JSON.parse(await readFile(path.join(root, "config.json"), "utf8")).token, saved.token);
    assert.match(JSON.parse(repeated.stdout).nextSteps[0], /Existing settings preserved port/);
    const doctor = await run(["doctor", "--json"], env);
    assert.equal(JSON.parse(doctor.stdout).state, "offline");
    assert.equal(doctor.stdout.includes(saved.token), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("start reuses an unpaired service; machine diagnostics redact hostile health extras", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "browserpilot-reuse-"));
  const secret = randomBytes(48).toString("base64url");
  const listener = createServer((_request, response) => {
    response.end(JSON.stringify({ ready: false, serviceReady: true, backend: "extension", connectedProfiles: [], token: secret }));
  });
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  const env = { ...environment(root), BROWSERPILOT_COMPANION_TOKEN: secret, BROWSERPILOT_COMPANION_PORT: String(address.port) };
  try {
    const started = await run(["start", "--json"], env);
    assert.equal(started.code, 0);
    assert.equal(JSON.parse(started.stdout).started, false);
    assert.equal(JSON.parse(started.stdout).state, "browser_not_ready");
    const doctor = await run(["doctor", "--json"], env);
    assert.equal(doctor.code, 1);
    assert.equal(JSON.parse(doctor.stdout).state, "browser_not_ready");
    assert.match(JSON.parse(doctor.stdout).nextSteps.join(" "), /browserpilot pair/);
    assert.equal(doctor.stdout.includes(secret), false);
    assert.equal(started.stdout.includes(secret), false);
    assert.equal(listener.listening, true);
  } finally { listener.closeAllConnections(); await new Promise<void>((resolve) => listener.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

test("invalid configuration diagnostics do not echo credential content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "browserpilot-invalid-"));
  try {
    await writeFile(path.join(root, "config.json"), '{"token":"PRIVATE-CREDENTIAL",INVALID');
    const result = await run(["doctor", "--json"], environment(root));
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stdout).state, "configuration_invalid");
    assert.equal(result.stdout.includes("PRIVATE-CREDENTIAL"), false);
    assert.equal(result.stderr.includes("PRIVATE-CREDENTIAL"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
