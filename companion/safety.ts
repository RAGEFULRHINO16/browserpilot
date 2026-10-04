import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export function isPublicAddress(address: string): boolean {
  const normalized = address.toLowerCase();

  if (isIP(normalized) === 4) {
    const [a, b, c] = normalized.split(".").map(Number);
    return !(
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && ((b === 0 && (c === 0 || c === 2)) || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }

  if (isIP(normalized) === 6) {
    const words = ipv6Words(normalized);
    if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
      return isPublicAddress(`${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`);
    }
    // Limit routing to global unicast, excluding transition and special-use ranges.
    return words[0] >= 0x2000 && words[0] <= 0x3fff && words[0] !== 0x2002 &&
      !(words[0] === 0x2001 && (words[1] === 0 || words[1] === 2 || words[1] === 0xdb8 ||
        (words[1] >= 0x10 && words[1] <= 0x2f))) &&
      !(words[0] === 0x3fff && words[1] < 0x1000);
  }

  return false;
}

function ipv6Words(address: string): number[] {
  const dotted = address.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted[1].split(".").map(Number);
    address = address.slice(0, -dotted[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [left, right] = address.split("::");
  const before = left ? left.split(":").map((word) => parseInt(word, 16)) : [];
  if (right === undefined) return before;
  const after = right ? right.split(":").map((word) => parseInt(word, 16)) : [];
  return [...before, ...Array(8 - before.length - after.length).fill(0), ...after];
}

export async function publicUrlAddresses(value: string): Promise<Array<{ address: string; family: number }>> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return [];
  }

  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return [];
  const host = url.hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") ||
      host.endsWith(".local") || host.endsWith(".internal")) return [];

  if (isIP(host)) return isPublicAddress(host) ? [{ address: host, family: isIP(host) }] : [];

  try {
    const addresses = await lookup(host, { all: true });
    return addresses.length > 0 && addresses.every(({ address }) => isPublicAddress(address)) ? addresses : [];
  } catch {
    return [];
  }
}

export async function isPublicUrl(value: string): Promise<boolean> {
  return (await publicUrlAddresses(value)).length > 0;
}
