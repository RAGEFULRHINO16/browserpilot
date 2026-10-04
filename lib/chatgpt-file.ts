import { downloadPublicHttps } from "../companion/public-download";

const maxBytes = 10 * 1024 * 1024;

export async function downloadChatGptFile(rawUrl: string): Promise<Buffer> {
  return (await downloadPublicHttps(rawUrl, { maxBytes })).bytes;
}
