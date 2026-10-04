import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type BrowserContext } from "playwright";
import { isPublicUrl } from "./safety";

const profileIdPattern = /^[a-z][a-z0-9-]{0,31}$/;

export class BrowserProfiles {
  private readonly root: string;
  private activeContext: BrowserContext | undefined;
  activeId = "default";

  constructor(
    private readonly defaultDirectory: string,
    private readonly executablePath: string | undefined,
    private readonly headless: boolean,
  ) {
    this.root = path.dirname(defaultDirectory);
  }

  get context(): BrowserContext {
    if (!this.activeContext) throw new Error("Browser profile is not ready.");
    return this.activeContext;
  }

  async select(id: string): Promise<BrowserContext> {
    if (!profileIdPattern.test(id)) throw new Error("Profile ID must use lowercase letters, numbers, and hyphens.");
    if (this.activeContext && id === this.activeId) return this.activeContext;
    const directory = id === "default" ? this.defaultDirectory : path.join(this.root, id);
    await mkdir(directory, { recursive: true });
    const next = await chromium.launchPersistentContext(directory, {
      executablePath: this.executablePath,
      headless: this.headless,
      chromiumSandbox: true,
      acceptDownloads: true,
      serviceWorkers: "block",
    });
    await next.route("**/*", async (route) => {
      const url = route.request().url();
      if (!url.startsWith("http:") && !url.startsWith("https:")) return route.continue();
      return (await isPublicUrl(url)) ? route.continue() : route.abort();
    });
    const previous = this.activeContext;
    this.activeContext = next;
    this.activeId = id;
    if (previous) await previous.close();
    return next;
  }

  async reconnect(): Promise<BrowserContext> {
    const id = this.activeId;
    const previous = this.activeContext;
    this.activeContext = undefined;
    if (previous) await previous.close().catch(() => undefined);
    return this.select(id);
  }

  async list() {
    await mkdir(this.root, { recursive: true });
    const entries = await readdir(this.root, { withFileTypes: true });
    return ["default", ...entries.filter((item) => item.isDirectory() && item.name !== "default" && profileIdPattern.test(item.name)).map((item) => item.name)]
      .map((id) => ({ id, active: id === this.activeId }));
  }
}
