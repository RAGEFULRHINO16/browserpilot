import { sitePattern } from "./policy.js";

const status = document.getElementById("status");
const profile = document.getElementById("profile");
const save = document.getElementById("save");
const pairing = document.getElementById("pairing");
const site = document.getElementById("site");
const granted = document.getElementById("granted");
let stored = await chrome.storage.local.get(["profileId", "bridgeToken", "bridgePort"]);
profile.value = stored.profileId || "default";
status.textContent = stored.bridgeToken ? "Paired with your local companion." : "Run browserpilot pair, then paste its JSON below.";
const [current] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
if (current?.url?.startsWith("https://")) site.value = new URL(current.url).origin;

save.addEventListener("click", async () => {
  try {
    const value = profile.value.trim();
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(value)) throw new Error("Profile: lowercase letters, numbers and hyphens; max 32.");
    const update = { profileId: value };
    if (pairing.value.trim()) {
      const code = JSON.parse(pairing.value);
      if (!/^[a-f0-9]{64}$/.test(code.bridgeToken || "") || !Number.isInteger(code.bridgePort) || code.bridgePort < 1024 || code.bridgePort > 65535) throw new Error("Invalid local pairing JSON.");
      update.bridgeToken = code.bridgeToken;
      update.bridgePort = code.bridgePort;
    } else if (!stored.bridgeToken) throw new Error("Paste the local pairing JSON first.");
    await chrome.storage.local.set(update);
    stored = { ...stored, ...update };
    pairing.value = "";
    await chrome.runtime.sendMessage({ type: "reconnect" });
    status.textContent = "Saved. Connecting to your local companion.";
  } catch (error) { status.textContent = error.message; }
});

document.getElementById("grant").addEventListener("click", async () => {
  try {
    const origin = sitePattern(site.value.trim());
    const approved = await chrome.permissions.request({ origins: [origin] });
    status.textContent = approved ? `Approved ${origin}` : "Permission was declined.";
    await renderGrants();
  } catch (error) { status.textContent = error.message; }
});

document.getElementById("forget").addEventListener("click", async () => {
  await chrome.storage.local.remove(["bridgeToken", "bridgePort"]);
  stored = { profileId: stored.profileId };
  await chrome.runtime.sendMessage({ type: "reconnect" });
  status.textContent = "Pairing removed. The agent can no longer connect.";
});

document.getElementById("reconnect").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "reconnect" });
  await refreshConnection();
});

document.getElementById("approvals").addEventListener("click", async () => {
  const live = await chrome.runtime.sendMessage({ type: "connectionStatus" });
  if (live?.state !== "connected" || !Number.isInteger(live.port) || live.port < 1024 || live.port > 65535) return;
  await chrome.tabs.create({ url: `http://127.0.0.1:${live.port}/approvals` });
});

async function refreshConnection() {
  const live = await chrome.runtime.sendMessage({ type: "connectionStatus" }).catch(() => undefined);
  const state = live?.state || "disconnected";
  const copy = {
    unpaired: ["Step 1: pair your companion", "Run browserpilot setup, then browserpilot pair. Paste its private JSON below."],
    connecting: ["Connecting locally", "Waiting for the companion to accept this pairing. Keep your MCP client or browserpilot start running."],
    connected: ["Connected and ready", `Profile ${live?.profileId || "default"}. Approve websites below, then connect your MCP client. Changes still require local approval.`],
    disconnected: ["Companion is offline", "Start your MCP client or run browserpilot start. Run browserpilot doctor for recovery steps."],
    rejected: ["Pairing needs attention", "Run browserpilot pair again and replace the pairing JSON. A different companion may be using this port."],
  }[state] || ["Connection unavailable", "Run browserpilot doctor for recovery steps."];
  document.getElementById("connection").dataset.state = state;
  document.getElementById("connection-title").textContent = copy[0];
  document.getElementById("connection-help").textContent = copy[1];
  document.getElementById("approvals").disabled = state !== "connected";
}

async function renderGrants() {
  const permissions = await chrome.permissions.getAll();
  granted.replaceChildren();
  for (const origin of permissions.origins || []) {
    if (origin === "http://127.0.0.1/*") continue;
    const button = document.createElement("button");
    button.textContent = `Revoke ${origin}`;
    button.className = "secondary";
    button.addEventListener("click", async () => {
      await chrome.permissions.remove({ origins: [origin] });
      await renderGrants();
    });
    granted.append(button);
  }
}
await renderGrants();
await refreshConnection();
const refreshTimer = setInterval(refreshConnection, 2_000);
window.addEventListener("pagehide", () => clearInterval(refreshTimer));
