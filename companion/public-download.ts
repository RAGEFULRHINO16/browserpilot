import { request } from "node:https";
import type { LookupFunction } from "node:net";
import { publicUrlAddresses } from "./safety";

export function pinnedLookup(addresses: Array<{ address: string; family: number }>): LookupFunction {
  if (!addresses.length) throw new Error("No approved destination address.");
  return (_hostname, options, callback) => {
    const choices = options.family ? addresses.filter((item) => item.family === Number(options.family)) : addresses;
    if (!choices.length) return callback(new Error("No approved address for requested family."), "", 0);
    if (options.all) callback(null, choices);
    else callback(null, choices[0].address, choices[0].family);
  };
}

export async function downloadPublicHttps(rawUrl: string, options: {
  maxBytes: number;
  allowedMime?: ReadonlySet<string>;
}): Promise<{ bytes: Buffer; mime: string; finalUrl: string }> {
  let url = new URL(rawUrl);
  const signal = AbortSignal.timeout(30_000);
  for (let redirect = 0; redirect < 4; redirect++) {
    const addresses = url.protocol === "https:" ? await publicUrlAddresses(url.href) : [];
    if (!addresses.length) throw new Error("Download source must be a public HTTPS URL.");
    const result = await new Promise<{ location?: string; bytes: Buffer; mime: string }>((resolve, reject) => {
      // TLS verifies the original hostname; the socket uses only approved addresses.
      const outgoing = request(url, { agent: false, lookup: pinnedLookup(addresses), signal }, (response) => {
        const status = response.statusCode || 0;
        if (status >= 300 && status < 400) {
          const location = response.headers.location;
          response.destroy();
          if (!location) reject(new Error("Download redirect has no location."));
          else resolve({ location, bytes: Buffer.alloc(0), mime: "" });
          return;
        }
        const mime = (response.headers["content-type"] || "").split(";", 1)[0].toLowerCase();
        if (status < 200 || status >= 300 || (options.allowedMime && !options.allowedMime.has(mime))) {
          response.destroy();
          reject(new Error(status >= 200 && status < 300 ? "Unsupported download content type." : `Download failed (${status}).`));
          return;
        }
        if (Number(response.headers["content-length"] || 0) > options.maxBytes) {
          response.destroy();
          reject(new Error("Download exceeds the size limit."));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > options.maxBytes) {
            response.destroy(new Error("Download exceeds the size limit."));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => resolve({ bytes: Buffer.concat(chunks, size), mime }));
      });
      outgoing.on("error", reject);
      outgoing.end();
    });
    if (result.location) { url = new URL(result.location, url); continue; }
    if (!result.bytes.length) throw new Error("Download response was empty.");
    return { bytes: result.bytes, mime: result.mime, finalUrl: url.href };
  }
  throw new Error("Download redirected too many times.");
}
