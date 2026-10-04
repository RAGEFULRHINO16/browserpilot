import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BrowserProfiles } from "./profiles";

test("portable profile routing lists default once and preserves named sibling profiles", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "browserpilot-profiles-"));
  try {
    await mkdir(path.join(root, "default"));
    await mkdir(path.join(root, "work"));
    await mkdir(path.join(root, "Not-a-profile"));
    const profiles = new BrowserProfiles(path.join(root, "default"), undefined, true);
    assert.deepEqual(await profiles.list(), [{ id: "default", active: true }, { id: "work", active: false }]);
    await assert.rejects(profiles.select("../escape"), /Profile ID/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
