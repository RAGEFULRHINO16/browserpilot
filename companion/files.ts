import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { Download } from "playwright";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_EMBED_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_LIST_ITEMS = 50;
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".pdf",
  ".txt", ".csv", ".json", ".md", ".docx", ".xlsx", ".pptx",
  ".zip", ".mp3", ".mp4", ".bin",
]);
const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".pdf": "application/pdf", ".txt": "text/plain", ".csv": "text/csv",
  ".json": "application/json", ".md": "text/markdown",
};

type Kind = "download" | "upload";
type FileEntry = { directory: string; name: string; kind: Kind };

function cleanFilename(filename: string, requireAllowedExtension = true): string {
  if (filename !== path.basename(filename) || filename !== path.win32.basename(filename)) {
    throw new Error("File name must not contain a path.");
  }
  const cleaned = filename.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
  if (!cleaned || cleaned === "." || cleaned === ".." || cleaned.length > 180 || cleaned.startsWith(".")) {
    throw new Error("Invalid file name.");
  }
  if (requireAllowedExtension && !ALLOWED_EXTENSIONS.has(path.extname(cleaned).toLowerCase())) {
    throw new Error("Unsupported file extension.");
  }
  return cleaned;
}

function mimeType(name: string): string {
  return MIME_BY_EXTENSION[path.extname(name).toLowerCase()] || "application/octet-stream";
}

export class BrowserFiles {
  private readonly ids = new Map<string, FileEntry>();
  private readonly reverse = new Map<string, string>();

  constructor(
    private readonly downloadDir: string,
    private readonly uploadDir: string,
  ) {}

  async initialize(): Promise<void> {
    await mkdir(this.downloadDir, { recursive: true });
    await mkdir(this.uploadDir, { recursive: true });
  }

  private register(directory: string, name: string, kind: Kind): string {
    const key = `${kind}:${directory}:${name}`;
    const existing = this.reverse.get(key);
    if (existing) return existing;
    const id = randomUUID();
    this.ids.set(id, { directory, name, kind });
    this.reverse.set(key, id);
    return id;
  }

  private async checkedPath(id: string): Promise<{ entry: FileEntry; fullPath: string; size: number }> {
    const entry = this.ids.get(id);
    if (!entry) throw new Error("Unknown file ID. List files again.");
    const root = await realpath(entry.directory);
    const fullPath = path.resolve(entry.directory, entry.name);
    const resolved = await realpath(fullPath);
    if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error("File escaped its configured folder.");
    const details = await lstat(fullPath);
    if (!details.isFile() || details.isSymbolicLink()) throw new Error("Only regular files are available.");
    return { entry, fullPath, size: details.size };
  }

  async listDownloads(): Promise<Array<{ id: string; name: string; size: number; modified: string; mimeType: string }>> {
    await this.initialize();
    const entries = await readdir(this.downloadDir, { withFileTypes: true });
    const files = await Promise.all(entries.filter((entry) => entry.isFile() && !entry.isSymbolicLink()).map(async (entry) => {
      const details = await stat(path.join(this.downloadDir, entry.name));
      return { name: entry.name, size: details.size, modified: details.mtime.toISOString(), timestamp: details.mtimeMs };
    }));
    return files.sort((a, b) => b.timestamp - a.timestamp).slice(0, MAX_LIST_ITEMS).map(({ name, size, modified }) => ({
      id: this.register(this.downloadDir, name, "download"), name, size, modified, mimeType: mimeType(name),
    }));
  }

  async readFile(id: string): Promise<
    | { id: string; name: string; mimeType: string; data: string }
    | { id: string; name: string; size: number; mimeType: string; text?: string; truncated?: boolean }
  > {
    const { entry, fullPath, size } = await this.checkedPath(id);
    const mime = mimeType(entry.name);
    if (mime.startsWith("image/") && mime !== "image/svg+xml" && size <= MAX_IMAGE_BYTES) {
      const file = await open(fullPath, constants.O_RDONLY);
      try {
        return { id, name: entry.name, mimeType: mime, data: (await file.readFile()).toString("base64") };
      } finally {
        await file.close();
      }
    }
    if (["text/plain", "text/csv", "text/markdown", "application/json", "image/svg+xml"].includes(mime)) {
      const file = await open(fullPath, constants.O_RDONLY);
      try {
        const buffer = Buffer.alloc(Math.min(size, MAX_TEXT_BYTES));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        return { id, name: entry.name, size, mimeType: mime, text: buffer.subarray(0, bytesRead).toString("utf8"), truncated: size > MAX_TEXT_BYTES };
      } finally {
        await file.close();
      }
    }
    if (size <= MAX_EMBED_BYTES && mime !== "application/octet-stream") {
      const file = await open(fullPath, constants.O_RDONLY);
      try {
        return { id, name: entry.name, mimeType: mime, data: (await file.readFile()).toString("base64") };
      } finally {
        await file.close();
      }
    }
    return { id, name: entry.name, size, mimeType: mime };
  }

  async stageBase64(filename: string, base64: string): Promise<{ id: string; name: string; size: number; mimeType: string }> {
    const name = cleanFilename(filename);
    if (base64.length > Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
      throw new Error("Invalid or oversized base64 file.");
    }
    const bytes = Buffer.from(base64, "base64");
    if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES) throw new Error("File must be between 1 byte and 10 MiB.");
    await this.initialize();
    const storedName = `${randomUUID()}-${name}`;
    const fullPath = path.join(this.uploadDir, storedName);
    const file = await open(fullPath, "wx", 0o600);
    try {
      await file.writeFile(bytes);
    } finally {
      await file.close();
    }
    return { id: this.register(this.uploadDir, storedName, "upload"), name, size: bytes.length, mimeType: mimeType(name) };
  }

  async resolveForUpload(id: string): Promise<string> {
    const { fullPath, entry, size } = await this.checkedPath(id);
    if (entry.kind !== "upload" && entry.kind !== "download") throw new Error("File is not available for upload.");
    if (size > MAX_UPLOAD_BYTES) throw new Error("File exceeds the 10 MiB upload limit.");
    if (!ALLOWED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) throw new Error("Unsupported file extension for upload.");
    return fullPath;
  }

  async saveArtifact(filename: string, bytes: Buffer): Promise<{ id: string; name: string; size: number; mimeType: string }> {
    const name = cleanFilename(filename);
    if (!bytes.length || bytes.length > MAX_DOWNLOAD_BYTES) throw new Error("Artifact must be between 1 byte and 50 MiB.");
    await this.initialize();
    const storedName = `${randomUUID()}-${name}`;
    const fullPath = path.join(this.downloadDir, storedName);
    const file = await open(fullPath, "wx", 0o600);
    try {
      await file.writeFile(bytes);
    } finally {
      await file.close();
    }
    return { id: this.register(this.downloadDir, storedName, "download"), name, size: bytes.length, mimeType: mimeType(name) };
  }

  async saveDownload(download: Pick<Download, "suggestedFilename" | "saveAs" | "failure">): Promise<{ id: string; name: string; size: number; mimeType: string }> {
    const suggested = download.suggestedFilename();
    const name = cleanFilename(suggested, false);
    await this.initialize();
    const storedName = `${randomUUID()}-${name}`;
    const fullPath = path.join(this.downloadDir, storedName);
    await download.saveAs(fullPath);
    const failure = await download.failure();
    if (failure) throw new Error(`Download failed: ${failure}`);
    const details = await lstat(fullPath);
    if (!details.isFile() || details.isSymbolicLink()) throw new Error("Download is not a regular file.");
    if (details.size > MAX_DOWNLOAD_BYTES) {
      await unlink(fullPath);
      throw new Error("Download exceeds the 50 MiB limit.");
    }
    return { id: this.register(this.downloadDir, storedName, "download"), name, size: details.size, mimeType: mimeType(name) };
  }
}
