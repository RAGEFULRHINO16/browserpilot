import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("first-run diagnoses a missing browser without leaking logs and removes its temporary state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "browserpilot-prerequisite-"));
  const secret = "PRIVATE-DAILY-CREDENTIAL-MUST-NOT-APPEAR";
  const cache = path.join(root, "private-browser-cache");
  const dailyConfig = path.join(root, "must-not-create-daily-config.json");
  const script = fileURLToPath(new URL("./try-browser.mjs", import.meta.url));
  const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: cache,
    TEMP: root, TMP: root, TMPDIR: root,
    BROWSERPILOT_COMPANION_TOKEN: secret, BROWSERPILOT_CONFIG_PATH: dailyConfig,
    BROWSERPILOT_BROWSER_BACKEND: "extension" };
  try {
    const child = spawn(process.execPath, [script], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error("First-run prerequisite check timed out.")); }, 20_000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code) => { clearTimeout(timer); resolve(code); });
    });
    assert.equal(code, 1);
    assert.match(stderr, /Failed during MCP startup:/);
    assert.match(stderr, /Chromium is missing from the configured Playwright browser cache/);
    assert.match(stderr, /npx playwright install chromium in this same environment/);
    assert.equal(stderr.includes("confirm HTTPS access"), false, "a missing executable must not look like a network failure");
    assert.equal((stdout + stderr).includes(secret), false);
    assert.equal((stdout + stderr).includes(cache), false, "raw startup logs must remain private");
    assert.deepEqual(await readdir(root), [], "failed startup must remove temporary profiles and preserve inherited daily settings");
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});
