import { checkCommandDeadline, sitePattern } from "./policy.js";
const attached = new Set();
const diagnostics = [];
const network = new Map();
let socket;
let reconnectTimer;
let selectedTabId;
let pendingDownload;
let agentGroupId;
let agentWindowId;
let connection = { state: "unpaired", profileId: "default", port: null, pendingCommands: 0, lastConnectedAt: null };
let reconnectDelay = 2_000;
let connectingPromise;

function connectionState(state) {
  connection.state = state;
  chrome.action.setBadgeText({ text: { unpaired: "PAIR", connecting: "WAIT", connected: "", disconnected: "OFF", rejected: "PAIR" }[state] || "OFF" }).catch(() => undefined);
}

const groupTitle = "BrowserPilot";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pageId = (tabId) => `page-${tabId}`;
const tabIdFrom = (id) => {
  const match = /^page-(\d+)$/.exec(id || "");
  if (!match) throw new Error("Page ID is stale. List tabs again.");
  return Number(match[1]);
};
const cleanUrl = (raw) => {
  try { const url = new URL(raw); return /^https?:$/.test(url.protocol) ? `${url.origin}${url.pathname}` : raw; }
  catch { return raw; }
};
async function allowed(raw) {
  if (raw === "about:blank") return true;
  try { return await chrome.permissions.contains({ origins: [sitePattern(raw)] }); }
  catch { return false; }
}
async function createBlankTab(windowId) {
  const tab = await chrome.tabs.create({ windowId, url: "about:blank", active: false });
  if (!tab?.id) throw new Error("The browser could not create a BrowserPilot background tab.");
  // Chrome can return a tab with only pendingUrl before its first navigation commits.
  for (let attempt = 0; attempt < 80; attempt++) {
    const ready = await chrome.tabs.get(tab.id);
    if (ready.url === "about:blank" && ready.status === "complete") return ready;
    await pause(25);
  }
  throw new Error("BrowserPilot's new tab did not finish initializing. List tabs and retry.");
}
async function agentGroup(create = true) {
  const stored = await chrome.storage.session.get(["agentGroupId", "agentWindowId"]);
  const id = agentGroupId ?? stored.agentGroupId;
  const windowId = agentWindowId ?? stored.agentWindowId;
  if (Number.isInteger(id)) {
    const group = await chrome.tabGroups.get(id).catch(() => undefined);
    const focused = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => undefined);
    if (group?.title === groupTitle && focused?.id && group.windowId !== focused.id) {
      await chrome.tabGroups.move(group.id, { windowId: focused.id, index: -1 }).catch(() => undefined);
      const moved = await chrome.tabGroups.get(group.id).catch(() => undefined);
      if (moved?.title === groupTitle) {
        agentGroupId = moved.id;
        agentWindowId = moved.windowId;
        return moved;
      }
    }
    if (group?.title === groupTitle && (group.windowId === focused?.id || group.windowId === windowId)) {
      agentGroupId = id;
      agentWindowId = focused?.id || windowId;
      return group;
    }
  }
  if (!create) return undefined;
  const targetWindow = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
  if (!targetWindow?.id) throw new Error("Brave could not find your active browser window.");
  const tab = await createBlankTab(targetWindow.id);
  const groupId = await chrome.tabs.group({ tabIds: tab.id, createProperties: { windowId: targetWindow.id } });
  const group = await chrome.tabGroups.update(groupId, { title: groupTitle, color: "cyan" });
  await chrome.storage.session.set({ agentGroupId: groupId, agentWindowId: targetWindow.id });
  agentGroupId = groupId;
  agentWindowId = targetWindow.id;
  selectedTabId = tab.id;
  return group;
}
async function checkedTab(id, allowBlank = false) {
  const group = await agentGroup();
  const tab = await chrome.tabs.get(id).catch(() => undefined);
  if (!tab) throw new Error("Page ID is stale. List tabs again.");
  if (tab.groupId !== group.id) throw new Error("Only BrowserPilot group tabs can be controlled. List tabs again.");
  if (allowBlank && tab.url === "about:blank") return tab;
  if (!await allowed(tab.url || "")) throw new Error("This page cannot be controlled by BrowserPilot.");
  return tab;
}
async function currentTab() {
  const group = await agentGroup();
  if (selectedTabId !== undefined) {
    const selected = await chrome.tabs.get(selectedTabId).catch(() => undefined);
    if (selected?.groupId === group.id && await allowed(selected.url || "")) return selected;
  }
  for (const candidate of await chrome.tabs.query({ groupId: group.id })) {
    if (candidate.id && await allowed(candidate.url || "")) {
      selectedTabId = candidate.id;
      return candidate;
    }
  }
  throw new Error("No controllable BrowserPilot group tab is available. Open a new tab with BrowserPilot.");
}
async function targetTab(id, allowBlank = false) {
  return id ? checkedTab(tabIdFrom(id), allowBlank) : currentTab();
}
async function pageMessage(tabId, op, args = {}) {
  const tab = await checkedTab(tabId);
  if (tab.url === "about:blank") throw new Error("Open an approved website in this tab first.");
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  const response = await chrome.tabs.sendMessage(tabId, { channel: "browserpilot", op, args });
  if (response?.error) throw new Error(response.error);
  return response?.result;
}
async function snapshot(id) {
  const tab = await targetTab(id, true);
  selectedTabId = tab.id;
  if (tab.url === "about:blank") return { pageId: pageId(tab.id), url: "about:blank", title: "New tab", text: "", controls: [] };
  let result;
  for (let attempt = 0; attempt < 5; attempt++) {
    try { result = await pageMessage(tab.id, "snapshot"); break; }
    catch (error) { if (attempt === 4) throw error; await pause(250); }
  }
  return { pageId: pageId(tab.id), ...result };
}
async function listTabs() {
  const group = await agentGroup();
  const tabs = await chrome.tabs.query({ groupId: group.id });
  const visible = [];
  for (const tab of tabs) {
    if (!tab.id || !await allowed(tab.url || "")) continue;
    visible.push({ pageId: pageId(tab.id), url: cleanUrl(tab.url || ""), title: (tab.title || "").slice(0, 300), selected: tab.id === selectedTabId });
  }
  return visible;
}
async function focus(tabId) {
  const tab = await checkedTab(tabId, true);
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tabId, { active: true });
  selectedTabId = tabId;
}
async function ensureDebugger(tabId) {
  await checkedTab(tabId);
  if (attached.has(tabId)) return;
  try { await chrome.debugger.attach({ tabId }, "1.3"); }
  catch (error) { throw new Error(`Cannot attach to this Brave tab: ${error.message}. Close DevTools for the tab and retry.`); }
  attached.add(tabId);
  await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
  await chrome.debugger.sendCommand({ tabId }, "Network.enable");
  await chrome.debugger.sendCommand({ tabId }, "Page.enable");
}
async function cdp(tabId, method, params = {}) {
  await ensureDebugger(tabId);
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

chrome.debugger.onDetach.addListener((source) => {
  attached.delete(source.tabId);
  network.delete(source.tabId);
});
chrome.tabs.onCreated.addListener(async (tab) => {
  if (!tab.id || !tab.openerTabId) return;
  const group = await agentGroup(false);
  if (!group) return;
  const opener = await chrome.tabs.get(tab.openerTabId).catch(() => undefined);
  if (opener?.groupId === group.id) {
    await chrome.tabs.group({ tabIds: tab.id, groupId: group.id }).catch(() => undefined);
  }
});
chrome.tabs.onUpdated.addListener(async (tabId, change) => {
  if (!change.url && change.groupId === undefined) return;
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  const group = await agentGroup(false);
  if (tab?.groupId === group?.id && (!change.url || await allowed(change.url))) return;
  if (attached.has(tabId)) await chrome.debugger.detach({ tabId }).catch(() => undefined);
  for (let index = diagnostics.length - 1; index >= 0; index--) {
    if (diagnostics[index].pageId === pageId(tabId)) diagnostics.splice(index, 1);
  }
});
chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId === undefined) return;
  const state = network.get(tabId) || { requests: new Set(), changedAt: Date.now() };
  if (method === "Network.requestWillBeSent") { state.requests.add(params.requestId); state.changedAt = Date.now(); }
  if (method === "Network.loadingFinished" || method === "Network.loadingFailed") { state.requests.delete(params.requestId); state.changedAt = Date.now(); }
  network.set(tabId, state);
  let entry;
  if (method === "Runtime.exceptionThrown") entry = { type: "page_error", message: params.exceptionDetails?.text || "Page error" };
  if (method === "Runtime.consoleAPICalled" && params.type === "error") entry = { type: "console", message: params.args?.map((arg) => arg.value || arg.description || "").join(" ") || "Console error" };
  if (method === "Network.loadingFailed") entry = { type: "request_failed", message: params.errorText || "Request failed" };
  if (entry) {
    diagnostics.push({ ...entry, pageId: pageId(tabId), message: entry.message.slice(0, 500), at: Date.now() });
    if (diagnostics.length > 100) diagnostics.shift();
  }
});

async function mouse(tabId, target, action, destination) {
  const point = await pageMessage(tabId, "point", { target });
  await ensureDebugger(tabId);
  const at = (type, x, y, extra = {}) => chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", { type, x, y, ...extra });
  await at("mouseMoved", point.x, point.y);
  if (action === "hover") return;
  const button = action === "right_click" ? "right" : "left";
  const count = action === "double_click" ? 2 : 1;
  await at("mousePressed", point.x, point.y, { button, clickCount: count });
  if (action === "drag") {
    const end = await pageMessage(tabId, "point", { target: destination });
    for (let step = 1; step <= 8; step++) {
      const x = point.x + (end.x - point.x) * step / 8;
      const y = point.y + (end.y - point.y) * step / 8;
      await at("mouseMoved", x, y, { button: "left", buttons: 1 });
    }
    await at("mouseReleased", end.x, end.y, { button: "left", clickCount: 1 });
    return;
  }
  await at("mouseReleased", point.x, point.y, { button, clickCount: count });
  if (action === "double_click") {
    await at("mousePressed", point.x, point.y, { button: "left", clickCount: 2 });
    await at("mouseReleased", point.x, point.y, { button: "left", clickCount: 2 });
  }
}

async function capture(tabId, options = {}) {
  const quality = Math.max(20, Math.min(90, options.quality || 65));
  await checkedTab(tabId);
    if (options.target) {
      const videoFrame = await pageMessage(tabId, "videoFrame", { target: options.target }).catch(() => undefined);
      if (videoFrame) return videoFrame;
      const point = await pageMessage(tabId, "point", { target: options.target });
      const clip = { ...point.rect, scale: 1 };
      const result = await cdp(tabId, "Page.captureScreenshot", { format: "jpeg", quality, clip, captureBeyondViewport: true });
      return result.data;
    }
    const result = await cdp(tabId, "Page.captureScreenshot", { format: "jpeg", quality, captureBeyondViewport: !!options.fullPage });
    return result.data;
}

function safeDownloadName(name) {
  return (name.split(/[\\/]/).pop() || "download").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 160) || "download";
}
chrome.downloads.onCreated.addListener((item) => {
  if (!pendingDownload || pendingDownload.id || Date.parse(item.startTime) < pendingDownload.startedAt - 500) return;
  if (item.referrer) {
    try { if (new URL(item.referrer).origin !== pendingDownload.origin) return; }
    catch { return; }
  }
  pendingDownload.id = item.id;
});
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (pendingDownload && item.id === pendingDownload.id) {
    suggest({ filename: `BrowserPilot/${safeDownloadName(item.filename)}`, conflictAction: "uniquify" });
  }
});
async function watchDownload(tabId, timeoutMs, trigger) {
  if (pendingDownload) throw new Error("Another download is already being watched.");
  const tab = await checkedTab(tabId);
  const watch = { tabId, id: undefined, startedAt: Date.now(), origin: new URL(tab.url).origin };
  pendingDownload = watch;
  const started = Date.now();
  try {
    if (trigger) await mouse(tabId, trigger, "click");
    while (Date.now() - started < timeoutMs) {
      if (watch.id) {
        const [item] = await chrome.downloads.search({ id: watch.id });
        if (item?.state === "complete") return { name: safeDownloadName(item.filename), path: item.filename, url: item.finalUrl || item.url };
        if (item?.state === "interrupted") throw new Error(`Download failed: ${item.error || "interrupted"}`);
      }
      await pause(150);
    }
    throw new Error("Timed out waiting for a download.");
  } finally {
    pendingDownload = undefined;
  }
}

async function handle(command, args) {
  if (command === "ensure") {
    const tab = await currentTab();
    return { pageId: pageId(tab.id), url: cleanUrl(tab.url || "") };
  }
  if (command === "tabs") return listTabs();
  if (command === "snapshot") return snapshot(args.pageId);
  if (command === "url") return (await targetTab(args.pageId, true)).url || "";
  if (command === "open") {
    const pattern = sitePattern(args.url);
    if (!await chrome.permissions.contains({ origins: [pattern] })) {
      throw new Error("Brave has not granted BrowserPilot access to this site. Check the extension's site-access setting.");
    }
    const tab = await targetTab(args.pageId, true);
    await chrome.tabs.update(tab.id, { url: args.url, active: false });
    selectedTabId = tab.id;
    for (let attempt = 0; attempt < 40; attempt++) {
      const updated = await chrome.tabs.get(tab.id);
      if (updated.status === "complete") break;
      await pause(250);
    }
    return snapshot(pageId(tab.id));
  }
  if (command === "selectTab") { const tab = await targetTab(args.pageId, true); selectedTabId = tab.id; return snapshot(args.pageId); }
  if (command === "newTab") {
    const group = await agentGroup();
    const tab = await createBlankTab(group.windowId);
    await chrome.tabs.group({ tabIds: tab.id, groupId: group.id });
    selectedTabId = tab.id;
    return snapshot(pageId(tab.id));
  }
  if (command === "closeTab") {
    const tab = await targetTab(args.pageId, true);
    await chrome.tabs.remove(tab.id);
    if (selectedTabId === tab.id) selectedTabId = undefined;
    try { return snapshot(); } catch { return handle("newTab", {}); }
  }
  if (command === "navigate") {
    const tab = await targetTab(args.pageId);
    if (args.action === "reload") await chrome.tabs.reload(tab.id);
    else await cdp(tab.id, args.action === "back" ? "Page.navigateToHistoryEntry" : "Page.navigateToHistoryEntry", { entryId: await historyEntry(tab.id, args.action) });
    await pause(250);
    return snapshot(pageId(tab.id));
  }
  if (command === "dom") {
    const tab = await targetTab(args.pageId);
    return pageMessage(tab.id, args.op, args.args || {});
  }
  if (command === "interact") {
    const tab = await targetTab(args.pageId);
    const input = args.input;
    if (input.action === "fill") await pageMessage(tab.id, "fill", { target: input.target, text: input.text });
    else if (input.action === "select_option") await pageMessage(tab.id, "select", { target: input.target, values: input.values });
    else if (input.action === "upload") {
      const marker = crypto.randomUUID().replaceAll("-", "");
      await pageMessage(tab.id, "markUpload", { target: input.target, marker });
      try {
        const document = await cdp(tab.id, "DOM.getDocument", { depth: 1 });
        const node = await cdp(tab.id, "DOM.querySelector", { nodeId: document.root.nodeId, selector: `[data-browserpilot-upload="${marker}"]` });
        if (!node.nodeId) throw new Error("File input disappeared before upload.");
        await cdp(tab.id, "DOM.setFileInputFiles", { nodeId: node.nodeId, files: input.files });
      } finally { await pageMessage(tab.id, "clearUpload", { marker }).catch(() => undefined); }
    } else await mouse(tab.id, input.target, input.action, input.destination);
    await pause(100);
    return snapshot(pageId(tab.id));
  }
  if (command === "press") {
    const tab = await targetTab(args.pageId);
    const map = { Enter: 13, Escape: 27, Tab: 9, ArrowDown: 40, ArrowUp: 38, Backspace: 8 };
    const code = map[args.key];
    if (!code) throw new Error("Unsupported key.");
    const key = args.key;
    await cdp(tab.id, "Input.dispatchKeyEvent", { type: "keyDown", key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
    await cdp(tab.id, "Input.dispatchKeyEvent", { type: "keyUp", key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
    return snapshot(pageId(tab.id));
  }
  if (command === "scroll") {
    const tab = await targetTab(args.pageId);
    await pageMessage(tab.id, "scroll", { direction: args.direction, pixels: args.pixels });
    return snapshot(pageId(tab.id));
  }
  if (command === "focus") { await focus((await targetTab(args.pageId, true)).id); return { focused: true }; }
  if (command === "capture") {
    const tab = await targetTab(args.pageId);
    return { data: await capture(tab.id, args) };
  }
  if (command === "pdf") {
    const tab = await targetTab(args.pageId);
    const result = await cdp(tab.id, "Page.printToPDF", { printBackground: true, transferMode: "ReturnAsBase64" });
    return { data: result.data };
  }
  if (command === "download") {
    const tab = await targetTab(args.pageId);
    return watchDownload(tab.id, args.timeoutMs || 20_000, args.trigger);
  }
  if (command === "network") {
    const tab = await targetTab(args.pageId);
    await ensureDebugger(tab.id);
    const state = network.get(tab.id) || { requests: new Set(), changedAt: Date.now() };
    return { inflight: state.requests.size, idleMs: Date.now() - state.changedAt };
  }
  if (command === "diagnostics") {
    if (args.pageId) await targetTab(args.pageId);
    const permitted = new Set((await listTabs()).map((tab) => tab.pageId));
    return diagnostics.filter((entry) => permitted.has(entry.pageId) && (!args.pageId || entry.pageId === args.pageId)).slice(-50);
  }
  throw new Error(`Unsupported bridge command: ${command}`);
}

async function historyEntry(tabId, direction) {
  const history = await cdp(tabId, "Page.getNavigationHistory");
  const index = history.currentIndex + (direction === "back" ? -1 : 1);
  if (index < 0 || index >= history.entries.length) throw new Error(`No page to go ${direction} to.`);
  return history.entries[index].id;
}

async function connectOnce() {
  if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
  clearTimeout(reconnectTimer);
  const stored = await chrome.storage.local.get(["profileId", "bridgeToken", "bridgePort"]);
  if (!/^[a-f0-9]{64}$/.test(stored.bridgeToken || "") || !Number.isInteger(stored.bridgePort) || stored.bridgePort < 1024 || stored.bridgePort > 65535) {
    connection.port = null;
    connectionState("unpaired");
    return;
  }
  const profileId = /^[a-z][a-z0-9-]{0,31}$/.test(stored.profileId || "") ? stored.profileId : "default";
  connection.profileId = profileId;
  connection.port = stored.bridgePort;
  connectionState("connecting");
  const peer = new WebSocket(`ws://127.0.0.1:${stored.bridgePort}/bridge`);
  socket = peer;
  let commands = Promise.resolve();
  const handshakeTimer = setTimeout(() => {
    if (socket === peer && connection.state !== "connected") peer.close();
  }, 10_000);
  peer.addEventListener("open", () => {
    peer.send(JSON.stringify({ type: "hello", token: stored.bridgeToken, profileId }));
  });
  peer.addEventListener("message", (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message?.type === "ready" && message.profileId === profileId && socket === peer) {
      clearTimeout(handshakeTimer);
      reconnectDelay = 2_000;
      connection.lastConnectedAt = Date.now();
      connectionState("connected");
      return;
    }
    if (!Number.isSafeInteger(message.id)) return;
    connection.pendingCommands++;
    commands = commands.then(async () => {
      try {
        if (socket !== peer || peer.readyState !== WebSocket.OPEN) return;
        checkCommandDeadline(message.deadlineAt);
        const result = await handle(message.command, message.args || {});
        if (peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify({ id: message.id, result }));
      } catch (error) {
        if (peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify({ id: message.id, error: error instanceof Error ? error.message : "Browser action failed." }));
      } finally {
        connection.pendingCommands = Math.max(0, connection.pendingCommands - 1);
      }
    });
  });
  peer.addEventListener("close", (event) => {
    clearTimeout(handshakeTimer);
    if (socket !== peer) return;
    socket = undefined;
    connectionState(event.code === 1008 ? "rejected" : "disconnected");
    if (event.code !== 1008) {
      reconnectTimer = setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(30_000, reconnectDelay * 2);
    }
  });
  peer.addEventListener("error", () => peer.close());
}

async function connect() {
  if (connectingPromise) return connectingPromise;
  connectingPromise = connectOnce().finally(() => { connectingPromise = undefined; });
  return connectingPromise;
}

async function reconnect() {
  clearTimeout(reconnectTimer);
  await connectingPromise;
  socket?.close();
  socket = undefined;
  reconnectDelay = 2_000;
  return connect();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "connectionStatus") {
    sendResponse({ ...connection });
    return;
  }
  if (message?.type !== "reconnect") return;
  reconnect().then(() => sendResponse({ reconnecting: true })).catch(() => sendResponse({ reconnecting: false }));
  return true;
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !["bridgeToken", "bridgePort", "profileId"].some((key) => key in changes)) return;
  reconnect();
});
chrome.permissions.onRemoved.addListener(async () => {
  for (const tabId of attached) {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (!tab || !await allowed(tab.url || "")) {
      await chrome.debugger.detach({ tabId }).catch(() => undefined);
      attached.delete(tabId);
    }
  }
});
chrome.alarms.create("bridge-check", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => {
  if (socket?.readyState !== WebSocket.OPEN) connect();
});
setInterval(() => {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
}, 20_000);
connect();
