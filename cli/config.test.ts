import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../companion/config";

test("portable setup generates private independent credentials and preserves repeat configuration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "browserpilot-config-"));
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) if (key.startsWith("BROWSERPILOT_")) delete process.env[key];
  process.env.BROWSERPILOT_DATA_DIR = root;
  try {
    await assert.rejects(loadConfig(), /not configured/);
    const first = await loadConfig({ create: true, defaults: { companionPort: 8971 } });
    assert.equal(first.companionPort, 8971);
    assert.equal(first.backend, "extension");
    assert.equal(first.token.length, 64);
    assert.equal(first.executablePath, undefined);
    assert.equal(first.profileDir, path.join(root, "profiles", "default"));
    const raw = JSON.parse(await readFile(first.configPath, "utf8"));
    assert.equal(raw.token, first.token);
    const second = await loadConfig({ create: true, defaults: { companionPort: 8972 } });
    assert.equal(second.token, first.token);
    assert.equal(second.companionPort, 8971);
    if (process.platform !== "win32") assert.equal((await stat(first.configPath)).mode & 0o777, 0o600);
    process.env.BROWSERPILOT_COMPANION_PORT = "0";
    await assert.rejects(loadConfig());
  } finally {
    for (const key of Object.keys(process.env)) if (key.startsWith("BROWSERPILOT_")) delete process.env[key];
    for (const [key, value] of Object.entries(saved)) if (key.startsWith("BROWSERPILOT_") && value !== undefined) process.env[key] = value;
    await rm(root, { recursive: true, force: true });
  }
});
