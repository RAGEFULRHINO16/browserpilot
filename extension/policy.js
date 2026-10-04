export function privateHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!host || host === "localhost" || /\.(localhost|local|internal)$/.test(host)) return true;
  // Literal IPv6 is unavailable until browser policy has full address parity.
  if (host.includes(":")) return true;
  const parts = host.split(".").map(Number);
  if (parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    const [a, b, c] = parts;
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113);
  }
  return false;
}

export function sitePattern(raw) {
  const url = new URL(raw);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("Enter a public HTTP(S) website without embedded credentials.");
  if (privateHost(url.hostname)) throw new Error("Private or local sites cannot be controlled.");
  if (url.hostname === "accounts.google.com") throw new Error("Complete sign-in yourself in your browser.");
  return `${url.protocol}//${url.hostname}/*`;
}

export function checkCommandDeadline(deadlineAt, now = Date.now()) {
  if (!Number.isSafeInteger(deadlineAt) || deadlineAt > now + 120_000) {
    throw new Error("Invalid command deadline. Update the companion and extension together.");
  }
  if (deadlineAt <= now) throw new Error("Command expired before execution. No action was started. Take a fresh snapshot before retrying.");
}
