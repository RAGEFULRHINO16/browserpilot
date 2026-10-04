import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { isPublicUrl } from "./safety";
import { ApprovalGate, requiresActionApproval } from "./approval";
import { applyConfigEnvironment, loadConfig } from "./config";
import { localRequestAllowed } from "./local-http";
import { BrowserFiles } from "./files";
import { BrowserInteractions, extractSchema, targetSchema, waitSchema, type Interaction, type Target } from "./interaction";
import { BrowserProfiles } from "./profiles";
import type { BrowserController } from "./browser-controller";
import { ExtensionBridge } from "./extension-bridge";
import { ExtensionController } from "./extension-controller";
import { Workflows } from "./workflows";
import { siteSchema } from "./site-adapters";
import { fetchPublicImage } from "./image-download";

const settings = await loadConfig();
applyConfigEnvironment(settings);
const token = settings.token;
const host = "127.0.0.1";
const port = settings.companionPort;
const profileDir = settings.profileDir;
const downloadDir = settings.downloadDir;
const uploadDir = settings.uploadDir;
const chromePath = settings.executablePath;
const extensionMode = settings.backend === "extension";
const pageIdSchema = z.string().regex(/^page-\d+$/).optional();
const approvalIdSchema = z.string().length(32).optional();

function displayUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol)) return raw;
    return `${url.origin}${url.pathname}`;
  } catch {
    return raw;
  }
}

const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("status") }),
  z.object({ type: z.literal("open"), url: z.string().url(), pageId: pageIdSchema, profileId: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/).optional() }),
  z.object({ type: z.literal("snapshot"), pageId: pageIdSchema }),
  z.object({ type: z.literal("click"), index: z.number().int().min(0).max(500), pageId: pageIdSchema, approvalId: approvalIdSchema }),
  z.object({ type: z.literal("download"), index: z.number().int().min(0).max(500), pageId: pageIdSchema, approvalId: approvalIdSchema }),
  z.object({ type: z.literal("fill"), index: z.number().int().min(0).max(500), text: z.string().max(4000), pageId: pageIdSchema, approvalId: approvalIdSchema }),
  z.object({ type: z.literal("press"), key: z.enum(["Enter", "Escape", "Tab", "ArrowDown", "ArrowUp", "Backspace"]), pageId: pageIdSchema, approvalId: approvalIdSchema }),
  z.object({ type: z.literal("scroll"), direction: z.enum(["up", "down"]), pixels: z.number().int().min(1).max(3000), pageId: pageIdSchema }),
  z.object({ type: z.literal("screenshot"), pageId: pageIdSchema, fullPage: z.boolean().optional(), target: targetSchema.optional(), quality: z.number().int().min(20).max(90).optional() }),
  z.object({ type: z.literal("observe"), pageId: pageIdSchema, target: targetSchema.optional(), frames: z.number().int().min(1).max(4).default(3), intervalMs: z.number().int().min(250).max(2000).default(750) }),
  z.object({ type: z.literal("tabs") }),
  z.object({ type: z.literal("select_tab"), index: z.number().int().min(0).max(50).optional(), pageId: pageIdSchema }),
  z.object({ type: z.literal("new_tab") }),
  z.object({ type: z.literal("close_tab"), pageId: pageIdSchema }),
  z.object({ type: z.literal("navigate"), action: z.enum(["back", "forward", "reload"]), pageId: pageIdSchema }),
  z.object({ type: z.literal("interact"), action: z.enum(["click", "hover", "double_click", "right_click", "fill", "drag", "select_option"]), target: targetSchema, destination: targetSchema.optional(), text: z.string().max(4000).optional(), values: z.array(z.string().max(200)).max(20).optional(), pageId: pageIdSchema, approvalId: approvalIdSchema }),
  z.object({ type: z.literal("wait"), request: waitSchema, pageId: pageIdSchema, approvalId: approvalIdSchema }),
  z.object({ type: z.literal("find"), target: targetSchema, pageId: pageIdSchema, limit: z.number().int().min(1).max(50).default(20) }),
  z.object({ type: z.literal("extract"), request: extractSchema, pageId: pageIdSchema }),
  z.object({ type: z.literal("visual_read"), pageId: pageIdSchema, fullPage: z.boolean().optional() }),
  z.object({ type: z.literal("site_extract"), site: siteSchema, limit: z.number().int().min(1).max(100), pageId: pageIdSchema }),
  z.object({ type: z.literal("pdf"), pageId: pageIdSchema }),
  z.object({ type: z.literal("save_element_image"), target: targetSchema, pageId: pageIdSchema }),
  z.object({ type: z.literal("save_image"), index: z.number().int().min(0).max(500), pageId: pageIdSchema }),
  z.object({ type: z.literal("diagnostics"), pageId: pageIdSchema }),
  z.object({ type: z.literal("profiles") }),
  z.object({ type: z.literal("select_profile"), profileId: z.string().min(1).max(32) }),
  z.object({ type: z.literal("list_downloads") }),
  z.object({ type: z.literal("read_file"), fileId: z.string().uuid() }),
  z.object({ type: z.literal("stage_file"), filename: z.string().max(180), base64: z.string().max(14_000_000) }),
  z.object({ type: z.literal("upload"), target: targetSchema, fileIds: z.array(z.string().uuid()).min(1).max(10), pageId: pageIdSchema, approvalId: approvalIdSchema }),
  z.object({ type: z.literal("handoff"), pageId: pageIdSchema }),
  z.object({ type: z.literal("resume") }),
  z.object({ type: z.literal("workflow_start"), name: z.string().min(1).max(80) }),
  z.object({ type: z.literal("workflow_stop") }),
  z.object({ type: z.literal("workflow_list") }),
  z.object({ type: z.literal("workflow_begin"), workflowId: z.string().length(16) }),
  z.object({ type: z.literal("workflow_step"), approvalId: approvalIdSchema, retry: z.boolean().optional() }),
  z.object({ type: z.literal("workflow_status") }),
  z.object({ type: z.literal("workflow_cancel") }),
]);

type Action = z.infer<typeof actionSchema>;
const profiles = new BrowserProfiles(profileDir, chromePath, settings.headless);
const extensionBridge = new ExtensionBridge(createHmac("sha256", token).update("browserpilot-brave-extension-v1").digest("hex"), port);
const files = new BrowserFiles(downloadDir, uploadDir);
const approvals = new ApprovalGate(`http://${host}:${port}/approvals`);
const workflows = new Workflows(path.join(path.dirname(profileDir), "Workflows"));
let browser: BrowserController;
let handedOff = false;
const activeProfileId = () => extensionMode ? extensionBridge.activeId : profiles.activeId;

function browserReady(): boolean {
  if (extensionMode) return extensionBridge.connected();
  try {
    const context = profiles.context;
    return context.browser()?.isConnected() ?? context.pages().some((page) => !page.isClosed());
  } catch { return false; }
}

function health() {
  const connectedBraveProfiles = extensionBridge.profiles().map((profile) => profile.id);
  const ready = browserReady();
  const memory = process.memoryUsage();
  return { serviceReady: true, ready, backend: extensionMode ? "extension" : "playwright", profileId: activeProfileId(),
    connectedProfiles: extensionMode ? connectedBraveProfiles : ready ? [activeProfileId()] : [],
    connectedBraveProfiles, handedOff, workflows: workflows.health(), queueDepth, uptimeSeconds: process.uptime(),
    memory: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed } };
}

async function ensureBrowserPage(): Promise<void> {
  if (extensionMode) { await browser.ensurePage(); return; }
  try {
    await browser.ensurePage();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!/closed|disconnected|browser has been closed/i.test(message)) throw error;
    const context = await profiles.reconnect();
    browser = new BrowserInteractions(context, context.pages()[0] || await context.newPage(), [uploadDir, downloadDir]);
  }
}

function authorized(request: IncomingMessage): boolean {
  const supplied = request.headers.authorization?.replace(/^Bearer /i, "") || "";
  const expected = Buffer.from(token!);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function respond(response: ServerResponse, status: number, data: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(data));
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 14_100_000) throw new Error("Request is too large.");
    chunks.push(bytes);
  }
  const result = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  if (result?.type !== "stage_file" && size > 16_384) throw new Error("Request is too large.");
  return result;
}

async function guarded(input: Action, target: Target, pageId: string | undefined, execute: () => Promise<unknown>): Promise<unknown> {
  const description = await browser.describeTarget(target, pageId);
  const destination = input.type === "interact" && input.action === "drag" && input.destination
    ? await browser.describeTarget(input.destination, pageId) : undefined;
  return guardedAction(input, pageId, { target: description, destination }, `${input.type}: ${description.label || description.tag}`, execute);
}

async function guardedAction(input: Action, pageId: string | undefined, details: object, description: string, execute: () => Promise<unknown>): Promise<unknown> {
  if (!requiresActionApproval(input)) return execute();
  const url = await browser.currentUrl(pageId);
  const action = { request: { ...input, approvalId: undefined }, profileId: activeProfileId(),
    pageId: pageId || browser.activePageId, url, ...details };
  if (!approvals.consume("approvalId" in input ? input.approvalId : undefined, action)) {
    return approvals.prepare(action, description, { profileId: action.profileId, pageId: action.pageId,
      url: displayUrl(url), request: action.request, ...details });
  }
  return execute();
}

async function run(input: Action): Promise<unknown> {
  if (handedOff && !["status", "resume", "handoff", "snapshot", "tabs", "diagnostics", "workflow_status"].includes(input.type)) {
    throw new Error("BrowserPilot is paused for human takeover. Resume after completing the browser step.");
  }
  const noPageNeeded = new Set(["profiles", "select_profile", "list_downloads", "read_file", "stage_file",
    "tabs", "new_tab", "diagnostics", "workflow_start", "workflow_stop", "workflow_list", "workflow_begin",
    "workflow_status", "workflow_cancel", "workflow_step"]);
  if (extensionMode) noPageNeeded.add("status");
  if (!noPageNeeded.has(input.type) && !(input.type === "open" && input.profileId && input.profileId !== activeProfileId())) {
    await ensureBrowserPage();
  }
  switch (input.type) {
    case "status": {
      if (extensionMode) {
        if (!browserReady()) return { ...health(), pageId: null, url: null, headless: false,
          recovery: "Open your browser and reconnect the paired BrowserPilot extension." };
        const tabs = await browser.tabs();
        const current = tabs.find((tab) => tab.pageId === browser.activePageId) || tabs.find((tab) => tab.selected) || tabs[0];
        return { ready: true, profileId: activeProfileId(), pageId: current?.pageId || null,
          url: current ? displayUrl(current.url) : null, siteApprovalRequired: !current, headless: false, handedOff };
      }
      return { ready: true, profileId: activeProfileId(), pageId: browser.activePageId,
        url: displayUrl(await browser.currentUrl()), headless: process.env.BROWSERPILOT_HEADLESS === "1", handedOff };
    }
    case "open":
      if (!(await isPublicUrl(input.url))) throw new Error("Only public HTTP and HTTPS websites are allowed.");
      if (input.profileId && input.profileId !== activeProfileId()) {
        if (input.pageId) throw new Error("A page ID from another profile cannot be used when switching profiles.");
        if (extensionMode) {
          extensionBridge.select(input.profileId);
          browser = new ExtensionController(extensionBridge, downloadDir);
        } else {
          const context = await profiles.select(input.profileId);
          browser = new BrowserInteractions(context, context.pages()[0] || await context.newPage(), [uploadDir, downloadDir]);
        }
        handedOff = false;
      }
      const opened = await browser.open(input.url, input.pageId);
      workflows.record({ type: "open", url: displayUrl(input.url), pageId: input.pageId, profileId: input.profileId });
      return opened;
    case "snapshot":
      return browser.snapshot(input.pageId);
    case "click": {
      const target: Target = { by: "index", index: input.index };
      const result = await guarded(input, target, input.pageId, () => browser.interact({ action: "click", target }, input.pageId));
      if (!(result && typeof result === "object" && "approvalRequired" in result)) workflows.record({ type: "click", index: input.index, pageId: input.pageId });
      return result;
    }
    case "download": {
      const target: Target = { by: "index", index: input.index };
      return guarded(input, target, input.pageId, async () => {
        const download = await browser.download(target, input.pageId);
        return { downloaded: true, ...await files.saveDownload(download), url: displayUrl(download.url()) };
      });
    }
    case "fill": {
      const target: Target = { by: "index", index: input.index };
      return guarded(input, target, input.pageId, async () => {
        await browser.interact({ action: "fill", target, text: input.text }, input.pageId);
        return { filled: true, index: input.index };
      });
    }
    case "press": {
      const focused = await browser.focusedDescription(input.pageId);
      return guardedAction(input, input.pageId, { focused }, `Press ${input.key} in ${focused.label || focused.tag}`,
        () => browser.press(input.key, input.pageId));
    }
    case "scroll":
      await browser.scroll(input.direction, input.pixels, input.pageId);
      workflows.record({ type: "scroll", direction: input.direction, pixels: input.pixels, pageId: input.pageId });
      return browser.snapshot(input.pageId);
    case "screenshot":
      return { mimeType: "image/jpeg", data: (await browser.screenshot(input)).toString("base64") };
    case "observe": {
      const snapshot = await browser.snapshot(input.pageId);
      const mediaBefore = await browser.mediaState(input.pageId);
      const frames: Array<{ offsetMs: number; mimeType: string; data: string; hash: string }> = [];
      const started = Date.now();
      let totalBytes = 0;
      for (let index = 0; index < input.frames; index++) {
        if (index) await new Promise((resolve) => setTimeout(resolve, input.intervalMs));
        const bytes = await browser.screenshot({ pageId: input.pageId, target: input.target, quality: 50 });
        if (totalBytes + bytes.length > 8_000_000) break;
        totalBytes += bytes.length;
        frames.push({ offsetMs: Date.now() - started, mimeType: "image/jpeg", data: bytes.toString("base64"),
          hash: createHash("sha256").update(bytes).digest("hex") });
      }
      if (!frames.length) throw new Error("Visual capture exceeds the 8 MB response limit. Select a smaller element.");
      const mediaAfter = await browser.mediaState(input.pageId);
      return { snapshot, mediaBefore, mediaAfter, frames, truncated: frames.length < input.frames,
        visualChangeDetected: new Set(frames.map((frame) => frame.hash)).size > 1 };
    }
    case "tabs":
      return browser.tabs();
    case "select_tab": {
      const tabs = await browser.tabs();
      const pageId = input.pageId || (input.index === undefined ? undefined : tabs[input.index]?.pageId);
      if (!pageId) throw new Error("Tab is stale. List tabs again.");
      return browser.selectTab(pageId);
    }
    case "new_tab": return browser.newTab();
    case "close_tab": return browser.closeTab(input.pageId);
    case "navigate": {
      const result = await browser.navigate(input.action, input.pageId);
      workflows.record({ type: "navigate", action: input.action, pageId: input.pageId });
      return result;
    }
    case "interact": {
      let interaction: Interaction;
      if (input.action === "fill") {
        if (input.text === undefined) throw new Error("Text is required for fill.");
        interaction = { action: "fill", target: input.target, text: input.text };
      } else if (input.action === "drag") {
        if (!input.destination) throw new Error("Destination is required for drag.");
        interaction = { action: "drag", target: input.target, destination: input.destination };
      } else if (input.action === "select_option") {
        if (!input.values?.length) throw new Error("Values are required for select_option.");
        interaction = { action: "select_option", target: input.target, values: input.values };
      } else interaction = { action: input.action, target: input.target };
      const execute = () => browser.interact(interaction, input.pageId);
      const result = requiresActionApproval(input)
        ? await guarded(input, input.target, input.pageId, execute) : await execute();
      if (input.action !== "fill" && !(result && typeof result === "object" && "approvalRequired" in result)) {
        workflows.record({ ...input, approvalId: undefined });
      }
      return result;
    }
    case "wait": {
      if (input.request.for === "download") {
        const request = input.request;
        const execute = async () => {
          const download = await browser.waitDownload(request, input.pageId);
          return { downloaded: true, ...await files.saveDownload(download), url: displayUrl(download.url()) };
        };
        return request.trigger ? guarded(input, request.trigger, input.pageId, execute) : execute();
      }
      if ("trigger" in input.request && input.request.trigger) {
        return guarded(input, input.request.trigger, input.pageId, () => browser.wait(input.request, input.pageId));
      }
      return browser.wait(input.request, input.pageId);
    }
    case "find": return browser.find(input.target, input.pageId, input.limit);
    case "extract": return browser.extract(input.request, input.pageId);
    case "visual_read": return { snapshot: await browser.snapshot(input.pageId),
      mimeType: "image/jpeg", data: (await browser.screenshot({ pageId: input.pageId, fullPage: input.fullPage })).toString("base64") };
    case "site_extract": return browser.siteExtract(input.site, input.limit, input.pageId);
    case "pdf": return files.saveArtifact("page.pdf", await browser.pdf(input.pageId));
    case "save_element_image": return files.saveArtifact("element.jpg", await browser.screenshot({ pageId: input.pageId, target: input.target, quality: 85 }));
    case "save_image": {
      const image = await browser.imageSource(input.index, input.pageId);
      const file = await fetchPublicImage(image.src);
      return { ...await files.saveArtifact(`image-${input.index}${file.extension}`, file.bytes), alt: image.alt,
        source: displayUrl(image.src) };
    }
    case "diagnostics": return browser.diagnostics(input.pageId);
    case "profiles": return extensionMode ? extensionBridge.profiles() : profiles.list();
    case "select_profile": {
      if (extensionMode) {
        extensionBridge.select(input.profileId);
        browser = new ExtensionController(extensionBridge, downloadDir);
        await browser.ensurePage();
      } else {
        const context = await profiles.select(input.profileId);
        browser = new BrowserInteractions(context, context.pages()[0] || await context.newPage(), [uploadDir, downloadDir]);
      }
      return { profileId: activeProfileId(), snapshot: await browser.snapshot() };
    }
    case "list_downloads": return files.listDownloads();
    case "read_file": return files.readFile(input.fileId);
    case "stage_file": return files.stageBase64(input.filename, input.base64);
    case "upload": {
      const paths = await Promise.all(input.fileIds.map((id) => files.resolveForUpload(id)));
      const description = await browser.describeTarget(input.target, input.pageId);
      const names = paths.map((file) => path.basename(file).replace(/^[a-f0-9-]{36}-/, ""));
      return guardedAction(input, input.pageId, { target: description, files: names },
        `Upload ${names.join(", ")} to ${description.label || description.tag}`,
        () => browser.interact({ action: "upload", target: input.target, files: paths }, input.pageId));
    }
    case "handoff": {
      await browser.focus(input.pageId);
      handedOff = true;
      return { handedOff, profileId: activeProfileId(), snapshot: await browser.snapshot(input.pageId) };
    }
    case "resume": handedOff = false; return { handedOff, snapshot: await browser.snapshot() };
    case "workflow_start": return workflows.start(input.name);
    case "workflow_stop": return workflows.stop();
    case "workflow_list": return workflows.list();
    case "workflow_begin": return workflows.begin(input.workflowId);
    case "workflow_status": return workflows.status();
    case "workflow_step": {
      const step = workflows.peek();
      if (step.done) return step;
      if (step.retryRequired && (!step.retryAvailable || !input.retry)) return step;
      await workflows.running();
      try {
        const recorded = actionSchema.parse({ ...(step.action as object), approvalId: input.approvalId });
        const result = await run(recorded);
        if (result && typeof result === "object" && "approvalRequired" in result) return { ...await workflows.awaitingApproval(), result };
        return { ...await workflows.advance(), result };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Workflow step failed.";
        try { return { ...await workflows.fail(message), retryRequired: true }; }
        catch { return { ...workflows.status(), retryRequired: true, lastError: message }; }
      }
    }
    case "workflow_cancel": return workflows.cancel();
  }
}

await mkdir(profileDir, { recursive: true });
await files.initialize();
await workflows.load();
if (extensionMode) {
  browser = new ExtensionController(extensionBridge, downloadDir);
} else {
  const context = await profiles.select("default");
  browser = new BrowserInteractions(context, context.pages()[0] || await context.newPage(), [uploadDir, downloadDir]);
}

let queued = Promise.resolve();
let queueDepth = 0;

const server = createServer(async (request, response) => {
  if (!localRequestAllowed(request, port)) return respond(response, 403, { error: "Invalid local request origin or host." });
  if (request.url === "/approvals" && request.method === "GET") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" });
    return response.end(approvals.html());
  }
  const approvalMatch = request.url?.match(/^\/approvals\/([a-f0-9]{32})$/);
  if (approvalMatch && request.method === "POST") {
    if (!localRequestAllowed(request, port, { requireOrigin: true }) ||
        request.headers["content-type"]?.split(";", 1)[0] !== "application/x-www-form-urlencoded") {
      return respond(response, 403, { error: "Approval must be submitted from the local approval page." });
    }
    let form = "";
    for await (const chunk of request) {
      form += chunk.toString();
      if (form.length > 1000) return respond(response, 413, { error: "Request is too large." });
    }
    const valid = approvals.approve(approvalMatch[1], new URLSearchParams(form).get("csrf") || "");
    response.writeHead(valid ? 303 : 403, valid ? { location: "/approvals" } : { "content-type": "text/plain" });
    return response.end(valid ? "" : "Forbidden");
  }
  if (!authorized(request)) return respond(response, 401, { error: "Unauthorized" });
  if (request.url === "/health" && request.method === "GET") return respond(response, 200, health());
  if (request.url !== "/action" || request.method !== "POST") return respond(response, 404, { error: "Not found" });
  if (request.headers["content-type"]?.split(";", 1)[0] !== "application/json") return respond(response, 415, { error: "JSON is required." });
  if (queueDepth >= 16) return respond(response, 429, { error: "Browser action queue is full. Retry later." });
  queueDepth++;
  try {
    const input = actionSchema.parse(await body(request));
    const previous = queued;
    let release!: () => void;
    queued = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (response.destroyed) return;
      const result = await run(input);
      const warning = workflows.recordingWarning();
      respond(response, 200, { result: warning && result && typeof result === "object" && !Array.isArray(result)
        ? { ...result, workflowRecordingWarning: warning } : result });
    } finally {
      release();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Browser action failed";
    respond(response, 400, { error: message });
  } finally {
    queueDepth--;
  }
});
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.maxConnections = 32;
extensionBridge.attach(server);
server.listen(port, host, () => {
  process.stdout.write(`BrowserPilot companion listening on http://${host}:${port}\n`);
  process.stdout.write(extensionMode ? "Browser backend: daily Brave extension\n" : `Browser profile: ${profileDir}\n`);
  process.stdout.write(`Downloads: ${downloadDir}\n`);
  process.stdout.write("Sign in directly in Brave; passwords never pass through BrowserPilot tools.\n");
});
