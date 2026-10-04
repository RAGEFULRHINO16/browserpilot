import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Workflows } from "./workflows";

test("workflows persist and replay one step at a time", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "browserpilot-workflow-"));
  try {
    const workflows = new Workflows(directory);
    workflows.start("Browse reference");
    workflows.record({ type: "open", url: "https://example.com" });
    workflows.record({ type: "navigate", action: "reload" });
    const saved = await workflows.stop();
    assert.equal(saved.steps, 2);

    const restored = new Workflows(directory);
    await restored.load();
    assert.equal(restored.list().length, 1);
    await restored.begin(saved.id);
    const first = restored.peek();
    if (first.done) throw new Error("Expected a first workflow step.");
    assert.equal(first.index, 0);
    assert.deepEqual(first.action, { type: "open", url: "https://example.com" });
    await restored.running();

    const interrupted = new Workflows(directory);
    await interrupted.load();
    assert.equal(interrupted.status().state, "interrupted");
    const resumed = interrupted.peek();
    if (resumed.done) throw new Error("Expected an interrupted workflow step.");
    assert.equal(resumed.retryRequired, true);
    await interrupted.running();
    assert.equal((await interrupted.advance()).done, false);
    const second = interrupted.peek();
    if (second.done) throw new Error("Expected a second workflow step.");
    assert.equal(second.index, 1);
    assert.deepEqual(second.action, { type: "navigate", action: "reload" });
    await interrupted.running();
    assert.equal((await interrupted.fail("Navigation timed out")).lastError, "Navigation timed out");
    assert.equal(interrupted.status().retryAvailable, true);
    await interrupted.running();
    assert.equal((await interrupted.advance()).done, true);
    const finished = new Workflows(directory);
    await finished.load();
    assert.equal(finished.status().active, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
