import type { ExtractRequest, Interaction, Target, WaitRequest } from "./interaction";
import type { Site } from "./site-adapters";

export type BrowserDownload = {
  suggestedFilename(): string;
  saveAs(path: string): Promise<void>;
  failure(): Promise<string | null>;
  url(): string;
};

export interface BrowserController {
  readonly activePageId: string;
  ensurePage(): Promise<string>;
  currentUrl(pageId?: string): Promise<string>;
  open(url: string, pageId?: string): Promise<unknown>;
  snapshot(pageId?: string): Promise<unknown>;
  tabs(): Promise<Array<{ pageId: string; url: string; title: string; selected: boolean }>>;
  selectTab(pageId: string): Promise<unknown>;
  newTab(): Promise<unknown>;
  closeTab(pageId?: string): Promise<unknown>;
  navigate(action: "back" | "forward" | "reload", pageId?: string): Promise<unknown>;
  find(target: Target, pageId?: string, limit?: number): Promise<unknown>;
  describeTarget(target: Target, pageId?: string): Promise<{ label: string; tag: string; type?: string; href?: string; fingerprint?: string }>;
  interact(input: Interaction, pageId?: string): Promise<unknown>;
  wait(input: WaitRequest, pageId?: string): Promise<unknown>;
  waitDownload(input: Extract<WaitRequest, { for: "download" }>, pageId?: string): Promise<BrowserDownload>;
  download(target: Target, pageId?: string): Promise<BrowserDownload>;
  extract(input: ExtractRequest, pageId?: string): Promise<unknown>;
  siteExtract(site: Site, limit: number, pageId?: string): Promise<unknown>;
  screenshot(options?: { pageId?: string; fullPage?: boolean; target?: Target; quality?: number }): Promise<Buffer>;
  mediaState(pageId?: string): Promise<unknown>;
  pdf(pageId?: string): Promise<Buffer>;
  imageSource(index: number, pageId?: string): Promise<{ src: string; alt: string }>;
  diagnostics(pageId?: string): Promise<unknown>;
  focusedDescription(pageId?: string): Promise<{ label: string; tag: string; type: string; fingerprint?: string }>;
  press(key: string, pageId?: string): Promise<unknown>;
  scroll(direction: "up" | "down", pixels: number, pageId?: string): Promise<unknown>;
  focus(pageId?: string): Promise<void>;
}
