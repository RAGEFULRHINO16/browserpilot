import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

type Workflow = { id: string; name: string; steps: unknown[]; createdAt: string };
type Replay = { workflowId: string; next: number; state: "ready" | "running" | "awaiting_approval" | "failed" | "interrupted"; attempts: number; lastError?: string; updatedAt: string };
const maxAttempts = 4;

export class Workflows {
  private readonly file: string;
  private readonly replayFile: string;
  private saved: Workflow[] = [];
  private recording: Workflow | undefined;
  private replay: Replay | undefined;

  constructor(directory: string) {
    this.file = path.join(directory, "workflows.json");
    this.replayFile = path.join(directory, "replay.json");
  }

  async load(): Promise<void> {
    try {
      const value = JSON.parse(await readFile(this.file, "utf8"));
      if (Array.isArray(value)) this.saved = value.filter((item) => item && typeof item.id === "string" && Array.isArray(item.steps));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      const value = JSON.parse(await readFile(this.replayFile, "utf8")) as Replay;
      if (this.saved.some((workflow) => workflow.id === value.workflowId) && Number.isInteger(value.next) && value.next >= 0) {
        this.replay = value;
        if (value.state === "running" || value.state === "awaiting_approval") {
          this.replay.state = "interrupted";
          this.replay.lastError = "BrowserPilot restarted during this step. Inspect the page before retrying.";
          await this.persistReplay();
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async persistReplay(): Promise<void> {
    if (!this.replay) {
      await unlink(this.replayFile).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      return;
    }
    this.replay.updatedAt = new Date().toISOString();
    await mkdir(path.dirname(this.replayFile), { recursive: true });
    const temporary = `${this.replayFile}.tmp`;
    await writeFile(temporary, JSON.stringify(this.replay, null, 2), { mode: 0o600 });
    await rename(temporary, this.replayFile);
  }

  start(name: string) {
    if (this.recording) throw new Error("A workflow is already recording.");
    if (this.replay) throw new Error("Finish or cancel the active replay before recording a new workflow.");
    this.recording = { id: randomBytes(8).toString("hex"), name: name.slice(0, 80), steps: [], createdAt: new Date().toISOString() };
    return { recording: true, id: this.recording.id, name: this.recording.name };
  }

  async stop() {
    if (!this.recording) throw new Error("No workflow is recording.");
    const workflow = this.recording;
    this.recording = undefined;
    this.saved.push(workflow);
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.saved, null, 2), { mode: 0o600 });
    return { recording: false, id: workflow.id, name: workflow.name, steps: workflow.steps.length };
  }

  record(action: unknown): void {
    if (!this.recording || this.replay) return;
    if (this.recording.steps.length >= 100) throw new Error("Workflow recording is limited to 100 steps.");
    this.recording.steps.push(action);
  }

  list() {
    return this.saved.map(({ id, name, steps, createdAt }) => ({ id, name, steps: steps.length, createdAt }));
  }

  async begin(id: string) {
    const workflow = this.saved.find((item) => item.id === id);
    if (!workflow) throw new Error("Workflow not found.");
    if (this.replay) throw new Error("A workflow replay is already active. Cancel or finish it first.");
    if (this.recording) throw new Error("Stop recording before beginning a replay.");
    if (!workflow.steps.length) return { active: false as const, done: true, id, total: 0 };
    this.replay = { workflowId: id, next: 0, state: "ready", attempts: 0, updatedAt: new Date().toISOString() };
    await this.persistReplay();
    return this.status();
  }

  status() {
    if (!this.replay) return { active: false as const };
    const workflow = this.saved.find((item) => item.id === this.replay!.workflowId);
    if (!workflow) throw new Error("Active workflow is missing.");
    return { active: true as const, id: workflow.id, name: workflow.name, next: this.replay.next,
      total: workflow.steps.length, progress: workflow.steps.length ? this.replay.next / workflow.steps.length : 1,
      state: this.replay.state, attempts: this.replay.attempts, maxAttempts,
      retryRequired: ["failed", "interrupted"].includes(this.replay.state),
      retryAvailable: this.replay.attempts < maxAttempts, lastError: this.replay.lastError,
      updatedAt: this.replay.updatedAt };
  }

  peek() {
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
    this.replay.state = "running";
    if (!wasAwaitingApproval) this.replay.attempts++;
    this.replay.lastError = undefined;
    await this.persistReplay();
    return this.status();
  }

  async awaitingApproval() {
    if (!this.replay) throw new Error("No workflow replay is active.");
    this.replay.state = "awaiting_approval";
    await this.persistReplay();
    return this.status();
  }

  async fail(message: string) {
    if (!this.replay) throw new Error("No workflow replay is active.");
    this.replay.state = "failed";
    this.replay.lastError = message.slice(0, 500);
    await this.persistReplay();
    return this.status();
  }

  async advance() {
    if (!this.replay) throw new Error("No workflow replay is active.");
    this.replay.next++;
    const workflow = this.saved.find((item) => item.id === this.replay!.workflowId)!;
    const done = this.replay.next >= workflow.steps.length;
    const state = { done, next: this.replay.next, total: workflow.steps.length };
    if (done) this.replay = undefined;
    else { this.replay.state = "ready"; this.replay.attempts = 0; this.replay.lastError = undefined; }
    await this.persistReplay();
    return { ...state, ...this.status() };
  }

  async cancel() {
    this.replay = undefined;
    await this.persistReplay();
    return { cancelled: true };
  }
}
