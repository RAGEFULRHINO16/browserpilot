import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises";
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
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("browserpilot-workflow-"));
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixture(action: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "browserpilot-workflow-"));
  try { await action(directory); }
  finally {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("browserpilot-workflow-"));
    await rm(directory, { recursive: true, force: true });
  }
}

test("corrupt and recursively executable catalogs are isolated and never overwritten", async () => {
  await fixture(async (directory) => {
    const file = path.join(directory, "workflows.json");
    for (const data of ["{broken", JSON.stringify([{ id: "a".repeat(16), name: "Recursive", createdAt: new Date().toISOString(),
      steps: [{ type: "workflow_step" }] }])]) {
      await writeFile(file, data);
      const workflows = new Workflows(directory);
      await workflows.load();
      assert.equal(workflows.health().catalogReady, false);
      assert.match(workflows.health().warnings[0], /preserved/);
      assert.deepEqual(workflows.list(), []);
      assert.throws(() => workflows.start("New"), /catalog is invalid/);
      await assert.rejects(workflows.stop(), /catalog is invalid/);
      assert.equal(await readFile(file, "utf8"), data);
    }
  });
});

test("invalid replay bounds preserve the journal and prevent replay or cancellation writes", async () => {
  await fixture(async (directory) => {
    const workflows = new Workflows(directory);
    workflows.start("Reference");
    workflows.record({ type: "open", url: "https://example.com" });
    const saved = await workflows.stop();
    const file = path.join(directory, "replay.json");
    for (const next of [1, -1]) {
      const data = JSON.stringify({ workflowId: saved.id, next, attempts: 0, state: "ready", updatedAt: new Date().toISOString() });
      await writeFile(file, data);
      const restored = new Workflows(directory);
      await restored.load();
      assert.equal(restored.health().catalogReady, true);
      assert.equal(restored.health().replayReady, false);
      await assert.rejects(restored.begin(saved.id), /journal is invalid/);
      await assert.rejects(restored.cancel(), /journal is invalid/);
      assert.equal(await readFile(file, "utf8"), data);
    }
  });
});

test("recording overflow is nonfatal and reports exactly the 100 safely recorded steps", async () => {
  await fixture(async (directory) => {
    const workflows = new Workflows(directory);
    workflows.start("Long session");
    for (let index = 0; index < 100; index++) assert.equal(workflows.record({ type: "scroll", direction: "down", pixels: 100 }), true);
    assert.equal(workflows.record({ type: "scroll", direction: "down", pixels: 100 }), false);
    assert.equal(workflows.status().recording.steps, 100);
    assert.equal(workflows.status().recording.acceptingSteps, false);
    assert.match(workflows.recordingWarning() || "", /action succeeded/);
    const saved = await workflows.stop();
    assert.equal(saved.steps, 100);
    assert.match(saved.warning || "", /100-step/);
    assert.equal(workflows.recordingWarning(), undefined);
    const restored = new Workflows(directory);
    await restored.load();
    assert.equal(restored.list()[0].steps, 100);
  });
});

test("an atomic catalog save failure retains the recording and removes temporary files", async () => {
  await fixture(async (directory) => {
    const workflows = new Workflows(directory);
    workflows.start("Still recoverable");
    workflows.record({ type: "navigate", action: "reload" });
    const destination = path.join(directory, "workflows.json");
    await mkdir(destination);
    await assert.rejects(workflows.stop());
    assert.equal(workflows.status().recording.active, true);
    assert.equal(workflows.status().recording.steps, 1);
    assert.deepEqual(workflows.list(), []);
    assert.deepEqual(await readdir(directory), ["workflows.json"]);
    await rmdir(destination);
    assert.equal((await workflows.stop()).steps, 1);
    const restored = new Workflows(directory);
    await restored.load();
    assert.equal(restored.health().catalogReady, true);
    assert.equal(restored.list().length, 1);
  });
});

test("journal write failure freezes replay and requires inspection rather than repeating a completed step", async () => {
  await fixture(async (directory) => {
    const workflows = new Workflows(directory);
    workflows.start("One write");
    workflows.record({ type: "click", index: 0, pageId: "page-123" });
    const saved = await workflows.stop();
    await workflows.begin(saved.id);
    await workflows.running();
    const destination = path.join(directory, "replay.json");
    await rm(destination);
    await mkdir(destination);
    await assert.rejects(workflows.advance(), /Inspect the page.*may have completed/);
    assert.equal(workflows.status().state, "interrupted");
    assert.equal(workflows.status().retryAvailable, false);
    assert.equal(workflows.health().replayReady, false);
    assert.throws(() => workflows.peek(), /journal could not be saved/);
    await assert.rejects(workflows.cancel(), /journal could not be saved/);
  });
});
