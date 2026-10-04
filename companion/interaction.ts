import path from "node:path";
import { randomInt } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { BrowserContext, Download, Locator, Page } from "playwright";
import { z } from "zod";
import type { BrowserController } from "./browser-controller";
import { extractSite, type Site } from "./site-adapters";

const controlSelector = "a[href], button, input, textarea, select, [role='button'], [role='link']";
const maxControls = 160;
const maxWaitMs = 30_000;

export const targetSchema = z.discriminatedUnion("by", [
  z.object({ by: z.literal("index"), index: z.number().int().min(0).max(500) }),
  z.object({ by: z.literal("role"), role: z.string().min(1).max(40), name: z.string().max(200).optional(), exact: z.boolean().optional(), matchIndex: z.number().int().min(0).max(50).optional() }),
  z.object({ by: z.literal("label"), value: z.string().min(1).max(200), exact: z.boolean().optional(), matchIndex: z.number().int().min(0).max(50).optional() }),
  z.object({ by: z.literal("text"), value: z.string().min(1).max(200), exact: z.boolean().optional(), matchIndex: z.number().int().min(0).max(50).optional() }),
  z.object({ by: z.literal("placeholder"), value: z.string().min(1).max(200), exact: z.boolean().optional(), matchIndex: z.number().int().min(0).max(50).optional() }),
  z.object({ by: z.literal("css"), value: z.string().min(1).max(500), matchIndex: z.number().int().min(0).max(50).optional() }),
]);
export type Target = z.infer<typeof targetSchema>;

export const waitSchema = z.discriminatedUnion("for", [
  z.object({ for: z.literal("page"), state: z.enum(["domcontentloaded", "load"]).default("domcontentloaded"), timeoutMs: z.number().int().min(100).max(maxWaitMs).default(10_000) }),
  z.object({ for: z.literal("target"), target: targetSchema, trigger: targetSchema.optional(), state: z.enum(["visible", "hidden", "attached", "detached"]).default("visible"), timeoutMs: z.number().int().min(100).max(maxWaitMs).default(10_000) }),
  z.object({ for: z.literal("url"), includes: z.string().min(1).max(500), trigger: targetSchema.optional(), timeoutMs: z.number().int().min(100).max(maxWaitMs).default(10_000) }),
  z.object({ for: z.literal("url_change"), trigger: targetSchema.optional(), timeoutMs: z.number().int().min(100).max(maxWaitMs).default(10_000) }),
  z.object({ for: z.literal("popup"), trigger: targetSchema.optional(), timeoutMs: z.number().int().min(100).max(maxWaitMs).default(10_000) }),
  z.object({ for: z.literal("download"), trigger: targetSchema.optional(), timeoutMs: z.number().int().min(100).max(maxWaitMs).default(10_000) }),
  z.object({ for: z.literal("network_idle"), timeoutMs: z.number().int().min(100).max(maxWaitMs).default(10_000) }),
]);
export type WaitRequest = z.infer<typeof waitSchema>;

export const extractSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("links"), limit: z.number().int().min(1).max(200).default(100) }),
  z.object({ mode: z.literal("images"), limit: z.number().int().min(1).max(200).default(100) }),
  z.object({ mode: z.literal("tables"), limit: z.number().int().min(1).max(20).default(10) }),
  z.object({ mode: z.literal("metadata") }),
  z.object({ mode: z.literal("target"), target: targetSchema }),
]);
export type ExtractRequest = z.infer<typeof extractSchema>;

export type Interaction =
  | { action: "click" | "hover" | "double_click" | "right_click"; target: Target }
  | { action: "fill"; target: Target; text: string }
  | { action: "drag"; target: Target; destination: Target }
  | { action: "select_option"; target: Target; values: string[] }
  | { action: "upload"; target: Target; files: string[] };

type Diagnostic = { type: "console" | "page_error" | "request_failed"; pageId: string; message: string; at: number };

function displayUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return /^https?:$/.test(url.protocol) ? `${url.origin}${url.pathname}` : raw;
  } catch {
    return raw;
  }
}

export class BrowserInteractions implements BrowserController {
  private readonly pages = new Map<string, Page>();
  private readonly diagnosticsLog: Diagnostic[] = [];
  private nextPage = randomInt(100_000_000, 999_999_999);
  private selectedPageId = "";

  constructor(private readonly context: BrowserContext, initialPage?: Page, private readonly uploadRoots: string[] = []) {
    for (const page of context.pages()) this.register(page);
    if (initialPage) this.selectedPageId = this.register(initialPage);
    context.on("page", (page) => {
      this.selectedPageId = this.register(page);
    });
  }

  get activePageId(): string {
    return this.selectedPageId;
  }

  /** Recreate the selected page after Brave or the persistent context was restarted. */
  async ensurePage(): Promise<string> {
    for (const [id, page] of this.pages) {
      if (page.isClosed()) this.pages.delete(id);
    }
    const active = this.pages.get(this.selectedPageId);
    if (active && !active.isClosed()) return this.selectedPageId;
    const page = await this.context.newPage();
    const pageId = this.register(page);
    this.selectedPageId = pageId;
    await page.bringToFront();
    return pageId;
  }

  private register(page: Page): string {
    for (const [id, known] of this.pages) if (known === page) return id;
    const id = `page-${this.nextPage++}`;
    this.pages.set(id, page);
    if (!this.selectedPageId) this.selectedPageId = id;
    page.on("close", () => {
      this.pages.delete(id);
      if (this.selectedPageId === id) this.selectedPageId = this.pages.keys().next().value || "";
    });
    page.on("pageerror", (error) => this.record({ type: "page_error", pageId: id, message: error.message.slice(0, 500), at: Date.now() }));
    page.on("console", (message) => {
      if (message.type() === "error") this.record({ type: "console", pageId: id, message: message.text().slice(0, 500), at: Date.now() });
    });
    page.on("requestfailed", (request) => this.record({ type: "request_failed", pageId: id, message: `${displayUrl(request.url())}: ${request.failure()?.errorText || "failed"}`.slice(0, 500), at: Date.now() }));
    return id;
  }

  private record(entry: Diagnostic): void {
    this.diagnosticsLog.push(entry);
    if (this.diagnosticsLog.length > 100) this.diagnosticsLog.shift();
  }

  page(pageId?: string): Page {
    const id = pageId || this.selectedPageId;
    const page = this.pages.get(id);
    if (!page || page.isClosed()) throw new Error("Page ID is stale. List tabs again.");
    return page;
  }

  async currentUrl(pageId?: string): Promise<string> {
    return this.page(pageId).url();
  }

  async open(url: string, pageId?: string): Promise<unknown> {
    await this.page(pageId).goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    return this.snapshot(pageId);
  }

  async focusedDescription(pageId?: string): Promise<{ label: string; tag: string; type: string; fingerprint: string }> {
    return this.page(pageId).evaluate(() => {
      const element = document.activeElement;
      const form = element?.closest("form");
      return { label: element?.getAttribute("aria-label") || element?.textContent?.trim().slice(0, 120) || "",
        tag: form ? "form" : element?.tagName.toLowerCase() || "", type: element?.getAttribute("type") || "",
        fingerprint: JSON.stringify({ tag: element?.tagName, attrs: ["id", "name", "type", "role", "formaction", "formmethod"].map((name) => element?.getAttribute(name) || ""),
          form: form ? [form.action, form.method, form.id] : null }) };
    });
  }

  async press(key: string, pageId?: string): Promise<unknown> {
    await this.page(pageId).keyboard.press(key);
    return this.snapshot(pageId);
  }

  async scroll(direction: "up" | "down", pixels: number, pageId?: string): Promise<unknown> {
    await this.page(pageId).mouse.wheel(0, direction === "down" ? pixels : -pixels);
    return this.snapshot(pageId);
  }

  async focus(pageId?: string): Promise<void> {
    await this.page(pageId).bringToFront();
  }

  async siteExtract(site: Site, limit: number, pageId?: string): Promise<unknown> {
    return extractSite(this.page(pageId), site, limit);
  }

  private locatorFor(page: Page, input: Target): Locator {
    let locator: Locator;
    switch (input.by) {
      case "index":
        locator = page.locator(controlSelector).nth(input.index);
        break;
      case "role":
        locator = page.getByRole(input.role as Parameters<Page["getByRole"]>[0], { name: input.name, exact: input.exact });
        break;
      case "label":
        locator = page.getByLabel(input.value, { exact: input.exact });
        break;
      case "text":
        locator = page.getByText(input.value, { exact: input.exact });
        break;
      case "placeholder":
        locator = page.getByPlaceholder(input.value, { exact: input.exact });
        break;
      case "css":
        locator = page.locator(input.value);
        break;
    }
    if ("matchIndex" in input && input.matchIndex !== undefined) locator = locator.nth(input.matchIndex);
    return locator;
  }

  private async target(page: Page, input: Target): Promise<Locator> {
    const locator = this.locatorFor(page, input);
    const count = await locator.count();
    if (!count) throw new Error("Target not found. Take a fresh snapshot or use a different locator.");
    if (count > 1) throw new Error(`Target matches ${count} elements. Use matchIndex to select one.`);
    return locator;
  }

  async find(input: Target, pageId?: string, limit = 20) {
    const page = this.page(pageId);
    const locator = this.locatorFor(page, input);
    const count = await locator.count();
    const matches = await locator.evaluateAll((elements, maximum) => elements.slice(0, maximum).map((element, matchIndex) => {
      const input = element instanceof HTMLInputElement ? element : null;
      const href = element instanceof HTMLAnchorElement ? new URL(element.href) : null;
      const bounds = element.getBoundingClientRect();
      return {
        matchIndex,
        tag: element.tagName.toLowerCase(),
        label: (element.getAttribute("aria-label") || input?.labels?.[0]?.textContent || (element as HTMLElement).innerText || input?.placeholder || "").trim().slice(0, 160),
        type: input?.type || undefined,
        href: href && /^https?:$/.test(href.protocol) ? `${href.origin}${href.pathname}` : undefined,
        visible: bounds.width > 0 && bounds.height > 0,
      };
    }), limit);
    return { pageId: this.register(page), count, matches };
  }

  async describeTarget(input: Target, pageId?: string) {
    return (await this.target(this.page(pageId), input)).evaluate((element) => {
      const input = element instanceof HTMLInputElement ? element : null;
      const label = element.getAttribute("aria-label") || input?.labels?.[0]?.textContent || (element as HTMLElement).innerText || input?.placeholder || element.getAttribute("title") || "";
      const href = element instanceof HTMLAnchorElement ? new URL(element.href) : null;
      const form = element.closest("form");
      return { label: label.trim().slice(0, 160), tag: element.tagName.toLowerCase(), type: input?.type || (element instanceof HTMLButtonElement ? element.type : undefined), href: href ? `${href.origin}${href.pathname}` : undefined,
        fingerprint: JSON.stringify({ tag: element.tagName, attrs: ["id", "name", "type", "role", "formaction", "formmethod", "contenteditable"].map((name) => element.getAttribute(name) || ""),
          href: href?.href || "", form: form ? [form.action, form.method, form.id] : null }) };
    });
  }

  async download(input: Target, pageId?: string): Promise<Download> {
    const page = this.page(pageId);
    const pending = page.waitForEvent("download", { timeout: 20_000 });
    const [download] = await Promise.all([pending, this.target(page, input).then((target) => target.click({ timeout: 10_000 }))]);
    return download;
  }

  async waitDownload(input: Extract<WaitRequest, { for: "download" }>, pageId?: string): Promise<Download> {
    const page = this.page(pageId);
    const pending = page.waitForEvent("download", { timeout: input.timeoutMs });
    if (!input.trigger) return pending;
    const [download] = await Promise.all([pending, this.target(page, input.trigger).then((target) => target.click({ timeout: input.timeoutMs }))]);
    return download;
  }

  async snapshot(pageId?: string) {
    const page = this.page(pageId);
    const id = this.register(page);
    const result = await page.evaluate(({ selector, maximum }) => {
      const controls = Array.from(document.querySelectorAll<HTMLElement>(selector)).map((element, index) => {
        const bounds = element.getBoundingClientRect();
        if (!bounds.width || !bounds.height) return null;
        const input = element instanceof HTMLInputElement ? element : null;
        const label = element.getAttribute("aria-label") || input?.labels?.[0]?.textContent || element.innerText?.trim() || input?.placeholder || element.getAttribute("title") || "";
        return { index, role: element.getAttribute("role") || element.tagName.toLowerCase(), label: label.slice(0, 120), type: input?.type || undefined, href: element instanceof HTMLAnchorElement ? element.href.split(/[?#]/, 1)[0] : undefined };
      }).filter(Boolean).slice(0, maximum);
      return { title: document.title, text: (document.body?.innerText || "").slice(0, 18_000), controls };
    }, { selector: controlSelector, maximum: maxControls });
    return { pageId: id, url: displayUrl(page.url()), ...result };
  }

  async tabs() {
    return Promise.all(Array.from(this.pages, async ([pageId, page]) => ({
      pageId, url: displayUrl(page.url()), title: await page.title().catch(() => ""), selected: pageId === this.selectedPageId,
    })));
  }

  async selectTab(pageId: string) {
    const page = this.page(pageId);
    this.selectedPageId = pageId;
    await page.bringToFront();
    return this.snapshot(pageId);
  }

  async newTab() {
    const page = await this.context.newPage();
    const pageId = this.register(page);
    this.selectedPageId = pageId;
    await page.bringToFront();
    return this.snapshot(pageId);
  }

  async closeTab(pageId?: string) {
    await this.page(pageId).close();
    if (!this.selectedPageId) return this.newTab();
    return this.snapshot();
  }

  async navigate(action: "back" | "forward" | "reload", pageId?: string) {
    const page = this.page(pageId);
    if (action === "back") await page.goBack({ waitUntil: "domcontentloaded", timeout: 30_000 });
    else if (action === "forward") await page.goForward({ waitUntil: "domcontentloaded", timeout: 30_000 });
    else await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    return this.snapshot(pageId);
  }

  private async guardSensitive(locator: Locator): Promise<void> {
    const details = await locator.evaluate((element) => ({
      tag: element.tagName.toLowerCase(),
      type: element.getAttribute("type"),
      name: element.getAttribute("name"),
      id: element.id,
      autocomplete: element.getAttribute("autocomplete"),
      label: element.getAttribute("aria-label"),
      contentEditable: element.getAttribute("contenteditable"),
    }));
    const identity = Object.values(details).join(" ");
    if (/password|passcode|one.time.code|otp|verification.code|credit.card|cc.number|cvv|cvc/i.test(identity)) {
      throw new Error("Complete sensitive sign-in and payment fields directly in the browser.");
    }
  }

  private async validateUploadPaths(files: string[]): Promise<string[]> {
    if (!this.uploadRoots.length) throw new Error("No upload folder is configured.");
    if (!files.length || files.length > 10) throw new Error("Provide 1 to 10 files.");
    const roots = await Promise.all(this.uploadRoots.map((root) => realpath(root)));
    return Promise.all(files.map(async (file) => {
      const resolved = await realpath(file);
      if (!roots.some((root) => resolved.toLowerCase().startsWith(`${root.toLowerCase()}${path.sep}`))) {
        throw new Error("Upload file is outside the approved folder.");
      }
      return resolved;
    }));
  }

  async interact(input: Interaction, pageId?: string) {
    const page = this.page(pageId);
    const target = await this.target(page, input.target);
    switch (input.action) {
      case "click": await target.click({ timeout: 10_000 }); break;
      case "hover": await target.hover({ timeout: 10_000 }); break;
      case "double_click": await target.dblclick({ timeout: 10_000 }); break;
      case "right_click": await target.click({ button: "right", timeout: 10_000 }); break;
      case "fill":
        if (input.text.length > 4_000) throw new Error("Text exceeds 4000 characters.");
        await this.guardSensitive(target);
        await target.fill(input.text, { timeout: 10_000 });
        break;
      case "drag":
        await target.dragTo(await this.target(page, input.destination), { timeout: 10_000 });
        break;
      case "select_option":
        if (!input.values.length || input.values.length > 20) throw new Error("Select 1 to 20 options.");
        await target.selectOption(input.values, { timeout: 10_000 });
        break;
      case "upload":
        await this.guardSensitive(target);
        await target.setInputFiles(await this.validateUploadPaths(input.files), { timeout: 10_000 });
        break;
    }
    return this.snapshot(pageId);
  }

  async wait(input: WaitRequest, pageId?: string): Promise<unknown> {
    const page = this.page(pageId);
    switch (input.for) {
      case "page":
        await page.waitForLoadState(input.state, { timeout: input.timeoutMs });
        return this.snapshot(pageId);
      case "target": {
        const locator = this.locatorFor(page, input.target);
        const pending = locator.waitFor({ state: input.state, timeout: input.timeoutMs });
        if (input.trigger) await Promise.all([pending, this.target(page, input.trigger).then((target) => target.click({ timeout: input.timeoutMs }))]);
        else await pending;
        return this.snapshot(pageId);
      }
      case "url": {
        const pending = page.waitForURL((url) => url.href.includes(input.includes), { timeout: input.timeoutMs });
        if (input.trigger) await Promise.all([pending, this.target(page, input.trigger).then((target) => target.click({ timeout: input.timeoutMs }))]);
        else await pending;
        return this.snapshot(pageId);
      }
      case "url_change": {
        const current = page.url();
        const pending = page.waitForURL((url) => url.href !== current, { timeout: input.timeoutMs });
        if (input.trigger) await Promise.all([pending, this.target(page, input.trigger).then((target) => target.click({ timeout: input.timeoutMs }))]);
        else await pending;
        return this.snapshot(pageId);
      }
      case "popup": {
        const pending = page.waitForEvent("popup", { timeout: input.timeoutMs });
        const popup = input.trigger
          ? (await Promise.all([pending, this.target(page, input.trigger).then((target) => target.click({ timeout: input.timeoutMs }))]))[0]
          : await pending;
        const popupId = this.register(popup);
        this.selectedPageId = popupId;
        await popup.waitForLoadState("domcontentloaded", { timeout: input.timeoutMs }).catch(() => undefined);
        return this.snapshot(popupId);
      }
      case "download": {
        throw new Error("Use the companion file store to save downloads.");
      }
      case "network_idle":
        await page.waitForLoadState("networkidle", { timeout: input.timeoutMs });
        return this.snapshot(pageId);
    }
  }

  async extract(input: ExtractRequest, pageId?: string): Promise<unknown> {
    const page = this.page(pageId);
    if (input.mode === "target") {
      const target = await this.target(page, input.target);
      return { pageId: this.register(page), text: (await target.innerText().catch(() => "")).slice(0, 10_000) };
    }
    return page.evaluate(({ mode, limit }) => {
      if (mode === "links") return Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]")).slice(0, limit).map((a) => {
        const url = new URL(a.href, location.href);
        return { text: (a.innerText || a.getAttribute("aria-label") || "").trim().slice(0, 200), href: `${url.origin}${url.pathname}` };
      });
      if (mode === "images") return Array.from(document.images).slice(0, limit).map((img) => {
        const url = new URL(img.currentSrc || img.src, location.href);
        return { src: /^https?:$/.test(url.protocol) ? `${url.origin}${url.pathname}` : "", alt: img.alt.slice(0, 200), width: img.naturalWidth, height: img.naturalHeight };
      });
      if (mode === "tables") return Array.from(document.querySelectorAll<HTMLTableElement>("table")).slice(0, limit).map((table) => Array.from(table.rows).slice(0, 100).map((row) => Array.from(row.cells).slice(0, 30).map((cell) => (cell.innerText || "").trim().slice(0, 500))));
      const meta = Array.from(document.querySelectorAll<HTMLMetaElement>("meta[name], meta[property]")).slice(0, 100).map((element) => ({ name: (element.name || element.getAttribute("property") || "").slice(0, 100), content: element.content.slice(0, 500) }));
      return { title: document.title, description: document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content.slice(0, 500) || "", canonical: document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href || "", meta };
    }, { mode: input.mode, limit: "limit" in input ? input.limit : 100 });
  }

  async screenshot(options: { pageId?: string; fullPage?: boolean; target?: Target; quality?: number } = {}): Promise<Buffer> {
    const page = this.page(options.pageId);
    const settings = { type: "jpeg" as const, quality: Math.max(20, Math.min(90, options.quality ?? 65)), timeout: 15_000 };
    if (options.target) return (await this.target(page, options.target)).screenshot(settings);
    return page.screenshot({ ...settings, fullPage: !!options.fullPage });
  }

  async mediaState(pageId?: string): Promise<unknown> {
    return this.page(pageId).locator("video").evaluateAll((videos) => videos.slice(0, 5).map((element) => {
      const video = element as HTMLVideoElement;
      return { currentTime: video.currentTime, duration: Number.isFinite(video.duration) ? video.duration : null,
        paused: video.paused, readyState: video.readyState, width: video.videoWidth, height: video.videoHeight };
    }));
  }

  async pdf(pageId?: string): Promise<Buffer> {
    return this.page(pageId).pdf({ printBackground: true });
  }

  async imageSource(index: number, pageId?: string): Promise<{ src: string; alt: string }> {
    return this.page(pageId).evaluate((imageIndex) => {
      const image = document.images.item(imageIndex);
      if (!image) throw new Error("Image index is stale. Extract images again.");
      return { src: image.currentSrc || image.src, alt: image.alt.slice(0, 200) };
    }, index);
  }

  async diagnostics(pageId?: string) {
    return this.diagnosticsLog.filter((entry) => !pageId || entry.pageId === pageId).slice(-50);
  }
}
