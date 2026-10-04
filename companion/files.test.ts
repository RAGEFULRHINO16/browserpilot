import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BrowserFiles } from "./files";

test("staged uploads are confined and size-checked", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "browserpilot-files-"));
  try {
    const files = new BrowserFiles(path.join(root, "downloads"), path.join(root, "uploads"));
    const staged = await files.stageBase64("photo.png", Buffer.from("image-data").toString("base64"));
    assert.equal(staged.name, "photo.png");
    assert.equal((await readFile(await files.resolveForUpload(staged.id))).toString(), "image-data");
    await assert.rejects(files.stageBase64("../secret.txt", "YQ=="), /path/);
    await assert.rejects(files.stageBase64("payload.exe", "YQ=="), /extension/);
    await assert.rejects(files.stageBase64("photo.png", "!!!"), /base64/);
    await assert.rejects(files.resolveForUpload("not-a-real-id"), /Unknown file ID/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("download listing and reads never follow symlinks outside the folder", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "browserpilot-files-"));
  try {
    const downloads = path.join(root, "downloads");
    const files = new BrowserFiles(downloads, path.join(root, "uploads"));
    await files.initialize();
    await writeFile(path.join(downloads, "safe.txt"), "visible");
    await writeFile(path.join(root, "private.txt"), "hidden");
    try {
      await symlink(path.join(root, "private.txt"), path.join(downloads, "link.txt"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      // Windows commonly requires elevated privileges to create a symlink.
    }
    const listed = await files.listDownloads();
    assert.deepEqual(listed.map((file) => file.name), ["safe.txt"]);
    const result = await files.readFile(listed[0].id);
    assert.equal("text" in result ? result.text : undefined, "visible");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("saved downloads receive opaque IDs and bounded image content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "browserpilot-files-"));
  try {
    const files = new BrowserFiles(path.join(root, "downloads"), path.join(root, "uploads"));
    const bytes = Buffer.from([137, 80, 78, 71]);
    const saved = await files.saveDownload({
      suggestedFilename: () => "image.png",
      saveAs: async (destination) => { await writeFile(destination, bytes); },
      failure: async () => null,
    });
    assert.equal(saved.name, "image.png");
    assert.equal(saved.size, bytes.length);
    assert.equal("data" in await files.readFile(saved.id), true);
    assert.deepEqual(await readFile(await files.resolveForUpload(saved.id)), bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
