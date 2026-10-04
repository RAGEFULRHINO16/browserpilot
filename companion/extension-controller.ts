import { constants } from "node:fs";
import { copyFile, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { BrowserController, BrowserDownload } from "./browser-controller";
import type { ExtractRequest, Interaction, Target, WaitRequest } from "./interaction";
import type { Site } from "./site-adapters";
import { ExtensionBridge } from "./extension-bridge";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Snapshot = { pageId: string; url: string; title: string; text: string; controls: unknown[] };
type DownloadInfo = { name: string; path: string; url: string };

export class ExtensionController implements BrowserController {
  private selected = "";

  constructor(private readonly bridge: ExtensionBridge, private readonly downloadDir: string) {}

  get activePageId(): string { return this.selected; }

  private async call<T>(command: string, args: unknown = {}, timeoutMs = 30_000): Promise<T> {
    return this.bridge.rpc<T>(command, args, undefined, timeoutMs);
  }

  async ensurePage(): Promise<string> {
    const result = await this.call<{ pageId: string }>("ensure");
    this.selected = result.pageId;
    return this.selected;
  }

  async currentUrl(pageId?: string): Promise<string> { return this.call("url", { pageId }); }
  async open(url: string, pageId?: string): Promise<unknown> {
    const result = await this.call<Snapshot>("open", { url, pageId });
    this.selected = result.pageId;
    return result;
  }
  async snapshot(pageId?: string): Promise<Snapshot> {
    const result = await this.call<Snapshot>("snapshot", { pageId });
    this.selected = result.pageId;
    return result;
  }
  async tabs() { return this.call<Array<{ pageId: string; url: string; title: string; selected: boolean }>>("tabs"); }
  async selectTab(pageId: string) { const result = await this.call<Snapshot>("selectTab", { pageId }); this.selected = result.pageId; return result; }
  async newTab() { const result = await this.call<Snapshot>("newTab"); this.selected = result.pageId; return result; }
  async closeTab(pageId?: string) { const result = await this.call<Snapshot>("closeTab", { pageId }); this.selected = result.pageId; return result; }
  async navigate(action: "back" | "forward" | "reload", pageId?: string) { return this.call<Snapshot>("navigate", { action, pageId }); }
  async find(target: Target, pageId?: string, limit = 20) {
    const result = await this.call<{ count: number; matches: unknown[] }>("dom", { pageId, op: "find", args: { target, limit } });
    return { pageId: pageId || this.selected, ...result };
  }
  async describeTarget(target: Target, pageId?: string) {
    return this.call<{ label: string; tag: string; type?: string; href?: string }>("dom", { pageId, op: "describe", args: { target } });
  }
  async interact(input: Interaction, pageId?: string) {
    const result = await this.call<Snapshot>("interact", { pageId, input });
    this.selected = result.pageId;
    return result;
  }

  private async downloadHandle(info: DownloadInfo): Promise<BrowserDownload> {
    const root = await realpath(this.downloadDir);
    const source = await realpath(info.path);
    if (!source.toLowerCase().startsWith(`${root.toLowerCase()}${path.sep}`)) {
      throw new Error("Brave saved the download outside BrowserPilot's approved Downloads folder.");
    }
    const details = await lstat(source);
    if (!details.isFile() || details.isSymbolicLink()) throw new Error("Download is not a regular file.");
    return {
      suggestedFilename: () => path.basename(source),
      saveAs: async (destination) => { await copyFile(source, destination, constants.COPYFILE_EXCL); },
      failure: async () => null,
      url: () => info.url,
    };
  }

  async download(target: Target, pageId?: string): Promise<BrowserDownload> {
    const info = await this.call<DownloadInfo>("download", { pageId, trigger: target, timeoutMs: 20_000 }, 25_000);
    return this.downloadHandle(info);
  }
  async waitDownload(input: Extract<WaitRequest, { for: "download" }>, pageId?: string): Promise<BrowserDownload> {
    const info = await this.call<DownloadInfo>("download", { pageId, trigger: input.trigger, timeoutMs: input.timeoutMs }, input.timeoutMs + 5_000);
    return this.downloadHandle(info);
  }

  async wait(input: WaitRequest, pageId?: string): Promise<unknown> {
    if (input.for === "download") throw new Error("Use the companion file store to save downloads.");
    const initialUrl = await this.currentUrl(pageId);
    const initialTabs = input.for === "popup" ? new Set((await this.tabs()).map((tab) => tab.pageId)) : undefined;
    if ("trigger" in input && input.trigger) await this.interact({ action: "click", target: input.trigger }, pageId);
    const deadline = Date.now() + input.timeoutMs;
    while (Date.now() < deadline) {
      if (input.for === "page") {
        const state = await this.call<{ readyState: string }>("dom", { pageId, op: "state" }).catch(() => undefined);
        if (state && (input.state === "domcontentloaded" ? state.readyState !== "loading" : state.readyState === "complete")) return this.snapshot(pageId);
      } else if (input.for === "target") {
        const state = await this.call<{ exists: boolean; visible: boolean }>("dom", { pageId, op: "state", args: { target: input.target } }).catch(() => undefined);
        if (state && ({ visible: state.visible, hidden: !state.visible, attached: state.exists, detached: !state.exists })[input.state]) return this.snapshot(pageId);
      } else if (input.for === "url" && (await this.currentUrl(pageId)).includes(input.includes)) return this.snapshot(pageId);
      else if (input.for === "url_change" && await this.currentUrl(pageId) !== initialUrl) return this.snapshot(pageId);
      else if (input.for === "popup") {
        const popup = (await this.tabs()).find((tab) => !initialTabs?.has(tab.pageId));
        if (popup) return this.selectTab(popup.pageId);
      } else if (input.for === "network_idle") {
        const state = await this.call<{ inflight: number; idleMs: number }>("network", { pageId });
        if (state.inflight === 0 && state.idleMs >= 500) return this.snapshot(pageId);
      }
      await pause(150);
    }
    throw new Error(`Timed out waiting for ${input.for}.`);
  }

  async extract(input: ExtractRequest, pageId?: string) {
    const result = await this.call<unknown>("dom", { pageId, op: "extract", args: { request: input } });
    return input.mode === "target" ? { pageId: pageId || this.selected, ...(result as object) } : result;
  }
  async siteExtract(site: Site, limit: number, pageId?: string) {
    return this.call("dom", { pageId, op: "siteExtract", args: { site, limit } });
  }
  async screenshot(options: { pageId?: string; fullPage?: boolean; target?: Target; quality?: number } = {}): Promise<Buffer> {
    const result = await this.call<{ data: string }>("capture", options, 30_000);
    return Buffer.from(result.data, "base64");
  }
  async mediaState(pageId?: string): Promise<unknown> {
    return this.call("dom", { pageId, op: "mediaState" });
  }
  async pdf(pageId?: string): Promise<Buffer> {
    const result = await this.call<{ data: string }>("pdf", { pageId }, 30_000);
    return Buffer.from(result.data, "base64");
  }
  async imageSource(index: number, pageId?: string): Promise<{ src: string; alt: string }> {
    return this.call("dom", { pageId, op: "imageSource", args: { index } });
  }
  async diagnostics(pageId?: string): Promise<unknown> { return this.call("diagnostics", { pageId }); }
  async focusedDescription(pageId?: string): Promise<{ label: string; tag: string; type: string }> {
    return this.call("dom", { pageId, op: "focused" });
  }
  async press(key: string, pageId?: string): Promise<unknown> { return this.call("press", { key, pageId }); }
  async scroll(direction: "up" | "down", pixels: number, pageId?: string): Promise<unknown> { return this.call("scroll", { direction, pixels, pageId }); }
  async focus(pageId?: string): Promise<void> { await this.call("focus", { pageId }); }
}
