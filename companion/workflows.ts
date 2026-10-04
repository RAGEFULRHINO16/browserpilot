import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { targetSchema } from "./interaction";

const maxAttempts = 4;
const maxSteps = 100;
const maxCatalogBytes = 4 * 1024 * 1024;
const pageId = z.string().regex(/^page-\d+$/).optional();
const stepSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("open"), url: z.string().url().max(4000), pageId,
    profileId: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/).optional() }),
  z.object({ type: z.literal("click"), index: z.number().int().min(0).max(500), pageId }),
  z.object({ type: z.literal("scroll"), direction: z.enum(["up", "down"]), pixels: z.number().int().min(1).max(3000), pageId }),
  z.object({ type: z.literal("navigate"), action: z.enum(["back", "forward", "reload"]), pageId }),
  z.object({ type: z.literal("interact"), action: z.enum(["click", "hover", "double_click", "right_click", "drag", "select_option"]),
    target: targetSchema, destination: targetSchema.optional(), values: z.array(z.string().max(200)).max(20).optional(), pageId }),
]).refine((step) => step.type !== "interact" ||
  (step.action !== "drag" || !!step.destination) && (step.action !== "select_option" || !!step.values?.length));
const workflowSchema = z.object({ id: z.string().regex(/^[a-f0-9]{16}$/), name: z.string().min(1).max(80),
  steps: z.array(stepSchema).max(maxSteps), createdAt: z.string().datetime() });
const catalogSchema = z.array(workflowSchema).max(1000).refine((items) => new Set(items.map((item) => item.id)).size === items.length);
const replaySchema = z.object({ workflowId: z.string().regex(/^[a-f0-9]{16}$/), next: z.number().int().min(0).max(maxSteps),
  state: z.enum(["ready", "running", "awaiting_approval", "failed", "interrupted"]),
  attempts: z.number().int().min(0).max(maxAttempts), lastError: z.string().max(500).optional(), updatedAt: z.string().datetime() });
type Workflow = z.infer<typeof workflowSchema>;
type Replay = z.infer<typeof replaySchema>;

async function readJson(file: string, limit: number): Promise<unknown> {
  if ((await stat(file)).size > limit) throw new Error("Workflow file exceeds its size limit.");
  const data = await readFile(file);
  if (data.length > limit) throw new Error("Workflow file exceeds its size limit.");
  return JSON.parse(data.toString("utf8"));
}

async function writeAtomic(file: string, value: unknown, limit = 4096): Promise<void> {
  const data = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(data) > limit) throw new Error("Workflow file exceeds its size limit; existing data was preserved.");
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, data, { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export class Workflows {
  private readonly file: string;
  private readonly replayFile: string;
  private saved: Workflow[] = [];
  private recording: Workflow | undefined;
  private replay: Replay | undefined;
  private catalogIssue: string | undefined;
  private replayIssue: string | undefined;
  private recordWarning: string | undefined;

  constructor(directory: string) {
    this.file = path.join(directory, "workflows.json");
    this.replayFile = path.join(directory, "replay.json");
  }

  async load(): Promise<void> {
    try {
      this.saved = catalogSchema.parse(await readJson(this.file, maxCatalogBytes));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.catalogIssue = "Workflow catalog is invalid or unreadable. Its file was preserved; repair or move workflows.json locally, then restart. Browser control remains available.";
      }
    }
    try {
      const value = replaySchema.parse(await readJson(this.replayFile, 4096));
      const workflow = this.saved.find((item) => item.id === value.workflowId);
      if (!workflow || value.next >= workflow.steps.length) throw new Error("Replay does not reference a valid step.");
      this.replay = value;
      if (value.state === "running" || value.state === "awaiting_approval") {
        await this.persistReplay({ ...value, state: "interrupted",
          lastError: "BrowserPilot restarted during this step. Inspect the page before retrying; the action may have completed." });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !this.replayIssue) {
        this.replayIssue = "Workflow replay journal is invalid or unreadable. Its file was preserved; inspect the page, repair or move replay.json locally, then restart. No automatic replay is attempted.";
      }
    }
  }

  health() {
    return { catalogReady: !this.catalogIssue, replayReady: !this.replayIssue,
      warnings: [this.catalogIssue, this.replayIssue].filter((issue): issue is string => !!issue) };
  }

  recordingWarning(): string | undefined { return this.recordWarning; }

  recordingStatus() {
    return { active: !!this.recording, id: this.recording?.id, name: this.recording?.name,
      steps: this.recording?.steps.length || 0, maxSteps, acceptingSteps: !!this.recording && !this.recordWarning,
      warning: this.recordWarning };
  }

  private requirePersistence(catalog = false): void {
    if (catalog && this.catalogIssue) throw new Error(this.catalogIssue);
    if (this.replayIssue) throw new Error(this.replayIssue);
  }

  private async persistReplay(next: Replay | undefined): Promise<void> {
    this.requirePersistence();
    try {
      if (!next) {
        await unlink(this.replayFile).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      } else {
        next = replaySchema.parse({ ...next, updatedAt: new Date().toISOString() });
        await writeAtomic(this.replayFile, next);
      }
      this.replay = next;
    } catch {
      this.replayIssue = "Workflow journal could not be saved. Inspect the page before retrying; the action may have completed. Repair replay.json locally, then restart; browser control remains available.";
      if (this.replay) this.replay = { ...this.replay, state: "interrupted", lastError: this.replayIssue };
      throw new Error(this.replayIssue);
    }
  }

  start(name: string) {
    this.requirePersistence(true);
    if (this.recording) throw new Error("A workflow is already recording.");
    if (this.replay) throw new Error("Finish or cancel the active replay before recording a new workflow.");
    this.recording = workflowSchema.parse({ id: randomBytes(8).toString("hex"), name: name.slice(0, 80), steps: [], createdAt: new Date().toISOString() });
    this.recordWarning = undefined;
    return { recording: true, id: this.recording.id, name: this.recording.name };
  }

  async stop() {
    this.requirePersistence(true);
    if (!this.recording) throw new Error("No workflow is recording.");
    const workflow = this.recording;
    const saved = catalogSchema.parse([...this.saved, workflow]);
    await writeAtomic(this.file, saved, maxCatalogBytes);
    this.saved = saved;
    this.recording = undefined;
    const warning = this.recordWarning;
    this.recordWarning = undefined;
    return { recording: false, id: workflow.id, name: workflow.name, steps: workflow.steps.length, warning };
  }

  record(action: unknown): boolean {
    if (!this.recording || this.replay || this.recordWarning) return false;
    const parsed = stepSchema.safeParse(action);
    if (!parsed.success) {
      this.recordWarning = "The browser action succeeded but could not be recorded safely. Recording is paused; stop and save the existing steps.";
      return false;
    }
    this.recording.steps.push(parsed.data);
    if (this.recording.steps.length === maxSteps) {
      this.recordWarning = "Recording reached the 100-step limit. The browser action succeeded; further actions will not be recorded. Stop and save this workflow before starting another.";
    }
    return true;
  }

  list() {
    return this.saved.map(({ id, name, steps, createdAt }) => ({ id, name, steps: steps.length, createdAt }));
  }

  async begin(id: string) {
    this.requirePersistence(true);
    const workflow = this.saved.find((item) => item.id === id);
    if (!workflow) throw new Error("Workflow not found.");
    if (this.replay) throw new Error("A workflow replay is already active. Cancel or finish it first.");
    if (this.recording) throw new Error("Stop recording before beginning a replay.");
    if (!workflow.steps.length) return { active: false as const, done: true, id, total: 0 };
    await this.persistReplay({ workflowId: id, next: 0, state: "ready", attempts: 0, updatedAt: new Date().toISOString() });
    return this.status();
  }

  status() {
    const diagnostics = { recording: this.recordingStatus(), persistence: this.health() };
    if (!this.replay) return { active: false as const, state: undefined, retryRequired: false,
      retryAvailable: false, lastError: undefined, ...diagnostics };
    const workflow = this.saved.find((item) => item.id === this.replay!.workflowId);
    if (!workflow) throw new Error("Active workflow is missing.");
    return { active: true as const, id: workflow.id, name: workflow.name, next: this.replay.next,
      total: workflow.steps.length, progress: workflow.steps.length ? this.replay.next / workflow.steps.length : 1,
      state: this.replay.state, attempts: this.replay.attempts, maxAttempts,
      retryRequired: ["failed", "interrupted"].includes(this.replay.state),
      retryAvailable: !this.replayIssue && this.replay.attempts < maxAttempts, lastError: this.replay.lastError,
      updatedAt: this.replay.updatedAt, ...diagnostics };
  }

  peek() {
    this.requirePersistence();
    if (!this.replay) throw new Error("No workflow replay is active.");
    const workflow = this.saved.find((item) => item.id === this.replay!.workflowId);
    if (!workflow) throw new Error("Active workflow is missing.");
    const action = workflow.steps[this.replay.next];
    if (!action) return { done: true as const };
    return { done: false as const, action, index: this.replay.next, total: workflow.steps.length,
      ...this.status() };
  }

  async running() {
    if (!this.replay) throw new Error("No workflow replay is active.");
    const wasAwaitingApproval = this.replay.state === "awaiting_approval";
    const attempts = this.replay.attempts + (wasAwaitingApproval ? 0 : 1);
    if (attempts > maxAttempts) throw new Error("Workflow retry limit reached. Inspect the page before starting a new replay.");
    await this.persistReplay({ ...this.replay, state: "running", attempts, lastError: undefined });
    return this.status();
  }

  async awaitingApproval() {
    if (!this.replay) throw new Error("No workflow replay is active.");
    await this.persistReplay({ ...this.replay, state: "awaiting_approval" });
    return this.status();
  }

  async fail(message: string) {
    if (!this.replay) throw new Error("No workflow replay is active.");
    await this.persistReplay({ ...this.replay, state: "failed", lastError: message.slice(0, 500) });
    return this.status();
  }

  async advance() {
    if (!this.replay) throw new Error("No workflow replay is active.");
    const next = this.replay.next + 1;
    const workflow = this.saved.find((item) => item.id === this.replay!.workflowId)!;
    const done = next >= workflow.steps.length;
    await this.persistReplay(done ? undefined : { ...this.replay, next, state: "ready", attempts: 0, lastError: undefined });
    return { done, next, total: workflow.steps.length, ...this.status() };
  }

  async cancel() {
    await this.persistReplay(undefined);
    return { cancelled: true };
  }
}
