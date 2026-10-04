import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

const storedSchema = z.object({
  token: z.string().min(32).max(512),
  companionPort: z.number().int().min(1024).max(65535).default(8765),
  backend: z.enum(["extension", "playwright"]).default("extension"),
  headless: z.boolean().default(false),
  executablePath: z.string().min(1).optional(),
});

export interface BrowserPilotConfig extends z.infer<typeof storedSchema> {
  dataDir: string;
  configPath: string;
  profileDir: string;
  downloadDir: string;
  uploadDir: string;
}

export function defaultDataDirectory(): string {
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA || os.homedir(), "BrowserPilot");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "BrowserPilot");
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "browserpilot");
}

export async function loadConfig(options: { create?: boolean; defaults?: Partial<z.infer<typeof storedSchema>> } = {}): Promise<BrowserPilotConfig> {
  // Private OS state is read at runtime, never bundled as a web deployment input.
  const dataDir = path.resolve(/* turbopackIgnore: true */ process.env.BROWSERPILOT_DATA_DIR || defaultDataDirectory());
  const configPath = path.resolve(/* turbopackIgnore: true */ process.env.BROWSERPILOT_CONFIG_PATH || path.join(dataDir, "config.json"));
  let stored: Partial<z.infer<typeof storedSchema>> = {};
  try {
    stored = storedSchema.parse(JSON.parse(await readFile(/* turbopackIgnore: true */ configPath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Invalid BrowserPilot configuration: ${configPath}`, { cause: error });
    if (!process.env.BROWSERPILOT_COMPANION_TOKEN && !options.create) {
      throw new Error("BrowserPilot is not configured. Run browserpilot init first.");
    }
    if (options.create && !process.env.BROWSERPILOT_COMPANION_TOKEN) {
      stored = storedSchema.parse({ ...options.defaults, token: randomBytes(48).toString("base64url") });
      await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
      try {
        await writeFile(configPath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      } catch (writeError) {
        if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
        stored = storedSchema.parse(JSON.parse(await readFile(/* turbopackIgnore: true */ configPath, "utf8")));
      }
    }
  }
  const value = storedSchema.parse({
    ...options.defaults, ...stored,
    token: process.env.BROWSERPILOT_COMPANION_TOKEN || stored.token,
    companionPort: process.env.BROWSERPILOT_COMPANION_PORT ? Number(process.env.BROWSERPILOT_COMPANION_PORT) : stored.companionPort ?? options.defaults?.companionPort,
    backend: process.env.BROWSERPILOT_BROWSER_BACKEND || stored.backend || options.defaults?.backend,
    headless: process.env.BROWSERPILOT_HEADLESS === undefined ? stored.headless ?? options.defaults?.headless : process.env.BROWSERPILOT_HEADLESS === "1",
    executablePath: process.env.BROWSERPILOT_CHROME_PATH || stored.executablePath || options.defaults?.executablePath,
  });
  return {
    ...value, dataDir, configPath,
    profileDir: path.resolve(/* turbopackIgnore: true */ process.env.BROWSERPILOT_PROFILE_DIR || path.join(dataDir, "profiles", "default")),
    downloadDir: path.resolve(/* turbopackIgnore: true */ process.env.BROWSERPILOT_DOWNLOAD_DIR || (value.backend === "extension"
      ? path.join(os.homedir(), "Downloads", "BrowserPilot") : path.join(dataDir, "downloads"))),
    uploadDir: path.resolve(/* turbopackIgnore: true */ process.env.BROWSERPILOT_UPLOAD_DIR || path.join(dataDir, "uploads")),
  };
}

export function applyConfigEnvironment(value: BrowserPilotConfig): void {
  process.env.BROWSERPILOT_COMPANION_TOKEN = value.token;
  process.env.BROWSERPILOT_COMPANION_PORT = String(value.companionPort);
  process.env.BROWSERPILOT_COMPANION_URL = `http://127.0.0.1:${value.companionPort}`;
  process.env.BROWSERPILOT_BROWSER_BACKEND = value.backend;
  process.env.BROWSERPILOT_HEADLESS = value.headless ? "1" : "0";
  process.env.BROWSERPILOT_PROFILE_DIR = value.profileDir;
  process.env.BROWSERPILOT_DOWNLOAD_DIR = value.downloadDir;
  process.env.BROWSERPILOT_UPLOAD_DIR = value.uploadDir;
  if (value.executablePath) process.env.BROWSERPILOT_CHROME_PATH = value.executablePath;
}
