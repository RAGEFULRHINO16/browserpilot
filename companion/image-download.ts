import { downloadPublicHttps } from "./public-download";

const maxImageBytes = 20 * 1024 * 1024;
const extensionByMime: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/svg+xml": ".svg",
};

export async function fetchPublicImage(rawUrl: string): Promise<{ bytes: Buffer; extension: string }> {
  const result = await downloadPublicHttps(rawUrl, { maxBytes: maxImageBytes, allowedMime: new Set(Object.keys(extensionByMime)) });
  return { bytes: result.bytes, extension: extensionByMime[result.mime] };
}
