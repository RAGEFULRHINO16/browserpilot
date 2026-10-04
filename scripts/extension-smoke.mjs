import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const token = randomBytes(48).toString("base64url");
const bridgeToken = createHmac("sha256", token).update("browserpilot-brave-extension-v1").digest("hex");
const probe = createServer();
const port = await new Promise((resolve) => probe.listen(0, "127.0.0.1", () => resolve(probe.address().port)));
await new Promise((resolve) => probe.close(resolve));
const temp = await mkdtemp(path.join(os.tmpdir(), "browserpilot-test-"));
const extension = path.join(temp, "extension");
const downloads = path.join(temp, "downloads", "BrowserPilot");
const uploads = path.join(temp, "uploads");
await cp(path.join(root, "extension"), extension, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(extension, "manifest.json"), "utf8"));
// Test-only permission simulates a single user-approved website.
manifest.host_permissions.push("https://example.com/*");
await writeFile(path.join(extension, "manifest.json"), JSON.stringify(manifest));

const companion = spawn(process.execPath, ["--import", "tsx", "companion/server.ts"], {
  cwd: root,
  env: { ...process.env, BROWSERPILOT_COMPANION_TOKEN: token, BROWSERPILOT_DATA_DIR: temp,
    BROWSERPILOT_CONFIG_PATH: path.join(temp, "config.json"), BROWSERPILOT_BROWSER_BACKEND: "extension", BROWSERPILOT_COMPANION_PORT: String(port),
    BROWSERPILOT_DOWNLOAD_DIR: downloads, BROWSERPILOT_UPLOAD_DIR: uploads },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
companion.stdout.on("data", (chunk) => { logs += chunk.toString(); });
companion.stderr.on("data", (chunk) => { logs += chunk.toString(); });
let browser;

const base = `http://127.0.0.1:${port}`;
const rawCall = async (action) => {
  const response = await fetch(`${base}/action`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(action) });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload.result;
};
const call = async (action, approve = true) => {
  const result = await rawCall(action);
  if (!result?.approvalRequired || !approve) return result;
  const html = await (await fetch(`${base}/approvals`)).text();
  const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
  if (!csrf) throw new Error("Approval fixture could not obtain local CSRF token.");
  const response = await fetch(`${base}/approvals/${result.approvalId}`, { method: "POST", redirect: "manual",
    headers: { Origin: base, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf }) });
  if (response.status !== 303) throw new Error(`Approval fixture failed (${response.status}).`);
  const executed = await rawCall({ ...action, approvalId: result.approvalId });
  if (executed?.approvalRequired) throw new Error(`Action changed after approval: ${action.type}`);
  return executed;
};

try {
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { ready = (await (await fetch(`${base}/health`, { headers: { Authorization: `Bearer ${token}` } })).json()).ready; }
    catch { await new Promise((resolve) => setTimeout(resolve, 200)); }
    if (ready) break;
  }
  if (!ready) throw new Error(`Companion did not start. ${logs}`);

  const profile = path.join(temp, "profile");
  await mkdir(path.join(profile, "Default"), { recursive: true });
  await mkdir(path.join(temp, "downloads"), { recursive: true });
  await writeFile(path.join(profile, "Default", "Preferences"), JSON.stringify({ download: { default_directory: path.join(temp, "downloads"), prompt_for_download: false } }));
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium", headless: true, chromiumSandbox: true, downloadsPath: downloads,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  browser = context;
  await context.route("https://example.com/**", (route) => route.fulfill({ contentType: "text/html", body: '<title>Example Domain</title><h1>Example Domain</h1><a href="https://www.iana.org/domains/example">Learn more</a>' }));
  let worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 10_000 });
  await worker.evaluate(async (settings) => {
    await chrome.storage.local.set(settings);
  }, { bridgeToken, bridgePort: port, profileId: "default" });
  const outsidePage = context.pages()[0] || await context.newPage();
  await outsidePage.goto("https://example.com", { waitUntil: "domcontentloaded" });
  const outsideId = await worker.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((tab) => tab.url === "https://example.com/" && tab.groupId === -1)?.id;
  });
  if (!outsideId) throw new Error("Test tab outside BrowserPilot group was not found.");
  const activeTabId = () => worker.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id);
  let status;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { status = await call({ type: "status" }); break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 200)); }
  }
  if (!status?.ready) throw new Error(`Extension did not connect. Worker: ${worker.url()} ${logs}`);
  const blank = await call({ type: "tabs" });
  if (blank.length !== 1 || blank[0].url !== "about:blank") throw new Error("BrowserPilot did not create an isolated group tab.");
  const beforeOpen = await worker.evaluate(async () => ({ groups: await chrome.tabGroups.query({ title: "BrowserPilot" }),
    tabs: (await chrome.tabs.query({})).map((tab) => ({ id: tab.id, windowId: tab.windowId, groupId: tab.groupId, active: tab.active, url: tab.url })) }));
  if (!beforeOpen.tabs.some((tab) => `page-${tab.id}` === blank[0].pageId && beforeOpen.groups.some((group) => group.id === tab.groupId))) {
    throw new Error(`BrowserPilot group tab mismatch before opening: ${JSON.stringify(beforeOpen)}`);
  }
  const openedFirst = await call({ type: "open", url: "https://example.com", pageId: blank[0].pageId });
  if (!openedFirst.title.includes("Example Domain")) throw new Error("Opening in the BrowserPilot group failed.");
  if (await activeTabId() !== outsideId) throw new Error("BrowserPilot navigation interrupted the active user tab.");
  let outsideRejected = false;
  try { await call({ type: "snapshot", pageId: `page-${outsideId}` }); }
  catch (error) { outsideRejected = /only browserpilot group tabs/i.test(error.message); }
  if (!outsideRejected) throw new Error("A tab outside BrowserPilot's group was accessible.");
  const page = context.pages().find((candidate) => candidate !== outsidePage && candidate.url() === "https://example.com/");
  if (!page) throw new Error("BrowserPilot group page was not found in isolated Brave.");
  const groupState = await worker.evaluate(async () => {
    const [group] = await chrome.tabGroups.query({ title: "BrowserPilot" });
    const tabs = group ? await chrome.tabs.query({ groupId: group.id }) : [];
    return { group, count: tabs.length };
  });
  if (!groupState.group || groupState.count !== 1 || groupState.group.color !== "cyan") throw new Error("BrowserPilot tab group is missing.");
  const snapshot = await call({ type: "snapshot" });
  if (!snapshot.title.includes("Example Domain") || !snapshot.pageId) throw new Error("Snapshot failed.");
  const found = await call({ type: "find", target: { by: "role", role: "link", name: "Learn more" } });
  if (found.count !== 1) throw new Error(`Semantic targeting failed: ${JSON.stringify({ found, controls: snapshot.controls })}`);
  const screenshot = await call({ type: "screenshot" });
  if (screenshot.mimeType !== "image/jpeg" || screenshot.data.length < 1000) throw new Error("Screenshot failed.");
  if (process.env.BROWSERPILOT_TEST_ARTIFACT_DIR) {
    await mkdir(process.env.BROWSERPILOT_TEST_ARTIFACT_DIR, { recursive: true });
    await writeFile(path.join(process.env.BROWSERPILOT_TEST_ARTIFACT_DIR, "extension-screenshot.jpg"), Buffer.from(screenshot.data, "base64"));
  }
  const observed = await call({ type: "observe", frames: 2, intervalMs: 300 });
  if (observed.frames.length !== 2 || observed.frames.some((frame) => !frame.data || frame.mimeType !== "image/jpeg") ||
      !Array.isArray(observed.mediaBefore) || !Array.isArray(observed.mediaAfter)) throw new Error("Visual frame observation failed.");
  if (await activeTabId() !== outsideId) throw new Error("Visual observation interrupted the active user tab.");
  const pdf = await call({ type: "pdf" });
  if (!pdf?.id || pdf.mimeType !== "application/pdf") throw new Error("PDF export failed.");
  const tabs = await call({ type: "tabs" });
  if (!tabs.some((tab) => tab.pageId === snapshot.pageId)) throw new Error("Tab management failed.");
  await page.setContent(`<!doctype html><title>BrowserPilot fixture</title><h1>Fixture</h1>
    <input aria-label="Note"><button id="increment" type="button" onclick="document.querySelector('#count').textContent = String(Number(document.querySelector('#count').textContent) + 1)">Increment</button>
    <span id="count">0</span><select aria-label="Color"><option value="red">Red</option><option value="blue">Blue</option></select>
    <input aria-label="Attachment" type="file"><a id="download-demo" download="demo.txt">Download demo</a>
    <video id="demo-clip" aria-label="Demo clip" muted autoplay playsinline width="320" height="180"></video>
    <script>
      document.querySelector('#download-demo').href = URL.createObjectURL(new Blob(['hello'], { type: 'text/plain' }));
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
      const context = canvas.getContext('2d'); let tick = 0;
      setInterval(() => { context.fillStyle = tick++ % 2 ? '#f00' : '#00f'; context.fillRect(0, 0, 320, 180); }, 100);
      document.querySelector('#demo-clip').srcObject = canvas.captureStream(12);
      document.querySelector('#demo-clip').play();
    </script>`);
  const fixture = await call({ type: "snapshot" });
  if (!fixture.text.includes("Fixture")) throw new Error("Fixture snapshot failed.");
  await page.waitForFunction(() => document.querySelector("#demo-clip")?.currentTime > 0.1, { timeout: 5000 });
  const clip = await call({ type: "observe", target: { by: "css", value: "#demo-clip" }, frames: 4, intervalMs: 500 });
  if (clip.frames.length !== 4 || clip.mediaAfter[0].currentTime <= clip.mediaBefore[0].currentTime || !clip.visualChangeDetected) {
    throw new Error(`Video playback could not be observed in the background window: ${JSON.stringify({ before: clip.mediaBefore, after: clip.mediaAfter, motion: clip.visualChangeDetected })}`);
  }
  if (await activeTabId() !== outsideId) throw new Error("Video observation interrupted the active user tab.");
  await call({ type: "interact", action: "click", target: { by: "role", role: "button", name: "Increment" } });
  if (await page.locator("#count").innerText() !== "1") throw new Error("Click failed.");
  if (await activeTabId() !== outsideId) throw new Error("BrowserPilot click interrupted the active user tab.");
  await call({ type: "interact", action: "fill", target: { by: "label", value: "Note" }, text: "BrowserPilot works" });
  if (await page.getByLabel("Note").inputValue() !== "BrowserPilot works") throw new Error("Fill failed.");
  await call({ type: "interact", action: "select_option", target: { by: "label", value: "Color" }, values: ["blue"] });
  if (await page.getByLabel("Color").inputValue() !== "blue") throw new Error("Select option failed.");
  const waited = await call({ type: "wait", request: { for: "target", target: { by: "css", value: "#count" }, state: "visible", timeoutMs: 2000 } });
  if (!waited.pageId) throw new Error("Wait failed.");
  const full = await call({ type: "screenshot", fullPage: true });
  const element = await call({ type: "screenshot", target: { by: "css", value: "#increment" } });
  if (full.data.length < 1000 || element.data.length < 500) throw new Error("Full or element screenshot failed.");
  const staged = await call({ type: "stage_file", filename: "upload.txt", base64: Buffer.from("hello").toString("base64") });
  const uploadAction = { type: "upload", target: { by: "label", value: "Attachment" }, fileIds: [staged.id] };
  const pending = await call(uploadAction, false);
  if (!pending.approvalRequired) throw new Error("Upload approval gate failed.");
  const html = await (await fetch(`${base}/approvals`)).text();
  const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
  if (!csrf) throw new Error("Local approval page is unavailable.");
  await fetch(`${base}/approvals/${pending.approvalId}`, { method: "POST", headers: { Origin: base, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf }) });
  await call({ ...uploadAction, approvalId: pending.approvalId });
  if (await page.getByLabel("Attachment").evaluate((input) => input.files.length) !== 1) throw new Error("Upload failed.");
  let downloaded;
  try { downloaded = await call({ type: "download", index: 4 }); }
  catch (error) {
    throw new Error(`Approved download failed: ${error.message}`);
  }
  if (!downloaded.downloaded || !downloaded.id) throw new Error("Download failed.");
  const extracted = await call({ type: "extract", request: { mode: "metadata" } }).catch((error) => {
    throw new Error(`Extraction after download failed at ${page.url()}: ${error.message}`);
  });
  if (extracted.title !== "BrowserPilot fixture") throw new Error("Structured extraction failed.");
  const fresh = await call({ type: "new_tab" });
  if (fresh.url !== "about:blank") throw new Error("New tab failed.");
  if (await activeTabId() !== outsideId) throw new Error("New BrowserPilot tab interrupted the active user tab.");
  const opened = await call({ type: "open", url: "https://example.com", pageId: fresh.pageId });
  if (!opened.title.includes("Example Domain")) throw new Error("Open in new tab failed.");
  await call({ type: "select_tab", pageId: fresh.pageId });
  if (await activeTabId() !== outsideId) throw new Error("Selecting a BrowserPilot page interrupted the active user tab.");
  const closed = await call({ type: "close_tab", pageId: fresh.pageId });
  if (!closed.pageId) throw new Error("Close tab failed.");
  const profiles = await call({ type: "profiles" });
  if (!profiles.some((profile) => profile.id === "default" && profile.connected)) throw new Error("Profile routing failed.");
  const handoff = await call({ type: "handoff", pageId: closed.pageId });
  if (!handoff.handedOff) throw new Error("Human handoff failed.");
  if (await activeTabId() === outsideId) throw new Error("Human handoff did not focus the BrowserPilot group.");
  const resumed = await call({ type: "resume" });
  if (resumed.handedOff) throw new Error("Human resume failed.");
  let denied = false;
  try { await call({ type: "open", url: "https://example.org" }); }
  catch (error) { denied = /not granted BrowserPilot access|permission|cannot be controlled/i.test(error.message); }
  if (!denied) throw new Error("An unapproved site was controllable.");
  denied = false;
  try { await call({ type: "open", url: "https://accounts.google.com" }); }
  catch (error) { denied = /sign.in|cannot be controlled/i.test(error.message); }
  if (!denied) throw new Error("Google sign-in page was not blocked.");
  denied = false;
  try { await call({ type: "open", url: "http://127.0.0.1:8080" }); }
  catch (error) { denied = /only public http/i.test(error.message); }
  if (!denied) throw new Error("Private-network destination was not blocked.");
  const beforeLabels = new Set(context.pages());
  const labelTab = await call({ type: "new_tab" });
  await call({ type: "open", url: "https://example.com", pageId: labelTab.pageId });
  const labelPage = context.pages().find((candidate) => !beforeLabels.has(candidate));
  if (!labelPage) throw new Error("Independent semantic-label fixture tab was not found.");
  await labelPage.setContent(`<!doctype html><title>BrowserPilot semantic labels</title>
    <section aria-label="Organization ID"><div><article><p>Organization ID</p>
      <label for="org-id">Organization ID</label><input id="org-id">
    </article></div></section>
    <label for="multi-label">Client ID</label><label for="multi-label">Workspace</label><input id="multi-label">
    <span id="aria-first">Primary</span><span id="aria-second">Contact</span>
    <input id="aria-input" aria-labelledby="aria-first aria-second" aria-label="Ignored accessible label">
    <span id="editable-label">Project notes</span><div id="editable-input" role="textbox" contenteditable="true" aria-labelledby="editable-label"></div>
    <div id="ordinary-draft" contenteditable="true">Documentation about password policies</div>
    <input type="hidden" aria-label="Hidden field">
    <label for="hidden-checkbox" style="display:block;padding:12px">Checkbox consent</label>
    <input id="hidden-checkbox" type="checkbox" style="display:none">
    <label for="hidden-radio" style="display:block;padding:12px">Radio choice</label>
    <input id="hidden-radio" name="plan" type="radio" style="opacity:0;position:absolute;width:1px;height:1px">
    <span id="verification-label">Verification code</span><input id="verification-input" aria-labelledby="verification-label">
    <label for="secondary-sensitive">Account value</label><label for="secondary-sensitive">CVV</label><input id="secondary-sensitive">
    <input id="credit-expiry" aria-label="Expiry" autocomplete="cc-exp">
    <label for="native-bound">Display name</label><label id="native-tail" for="native-bound">${"Ordinary context ".repeat(20)}one</label><input id="native-bound">
    <span id="association-first">Bound target</span><span id="association-second">Bound target</span>
    <input id="aria-bound" aria-labelledby="association-first">`);
  const labelFind = (value, exact = true) => call({ type: "find", pageId: labelTab.pageId, target: { by: "label", value, exact } });
  const organization = await labelFind("Organization ID", false);
  if (organization.count !== 1 || organization.matches[0].tag !== "input") {
    throw new Error(`Label targeting matched ancestors or text instead of the control: ${JSON.stringify(organization)}`);
  }
  for (const value of ["Client ID", "Workspace", "Client ID Workspace", "Primary Contact", "Project notes"]) {
    if ((await labelFind(value)).count !== 1) throw new Error(`Associated label targeting failed: ${value}`);
  }
  for (const value of ["Ignored accessible label", "Primary", "Hidden field"]) {
    if ((await labelFind(value)).count !== 0) throw new Error(`Label matching ignored accessibility precedence or native hidden state: ${value}`);
  }
  await call({ type: "interact", pageId: labelTab.pageId, action: "fill", target: { by: "label", value: "Organization ID", exact: true }, text: "org-42" });
  if (await labelPage.locator("#org-id").inputValue() !== "org-42") throw new Error("Unambiguous label fill failed.");
  await call({ type: "interact", pageId: labelTab.pageId, action: "fill", target: { by: "label", value: "Project notes", exact: true }, text: "notes" });
  if (await labelPage.locator("#editable-input").innerText() !== "notes") throw new Error("ARIA-labelled editable control fill failed.");
  await call({ type: "interact", pageId: labelTab.pageId, action: "fill", target: { by: "css", value: "#ordinary-draft" }, text: "ordinary revised draft" });
  if (await labelPage.locator("#ordinary-draft").innerText() !== "ordinary revised draft") throw new Error("Ordinary draft text was mistaken for a sensitive field.");
  for (const [label, selector] of [["Checkbox consent", "#hidden-checkbox"], ["Radio choice", "#hidden-radio"]]) {
    const located = await labelFind(label);
    if (located.count !== 1 || located.matches[0].tag !== "input") throw new Error(`Hidden native toggle label did not resolve to its input: ${label}`);
    await call({ type: "interact", pageId: labelTab.pageId, action: "click", target: { by: "label", value: label, exact: true } });
    if (!await labelPage.locator(selector).isChecked()) throw new Error(`Associated visible label did not toggle the hidden native input: ${label}`);
  }
  for (const selector of ["#verification-input", "#secondary-sensitive", "#credit-expiry"]) {
    let sensitiveDenied = false;
    try { await call({ type: "interact", pageId: labelTab.pageId, action: "fill", target: { by: "css", value: selector }, text: "do-not-write" }); }
    catch (error) { sensitiveDenied = /sensitive sign.in and payment fields/i.test(error.message); }
    if (!sensitiveDenied || await labelPage.locator(selector).inputValue() !== "") {
      throw new Error(`Sensitive referenced/native/autocomplete field was writable: ${selector}`);
    }
  }
  const approveLabelAction = async (pending) => {
    const html = await (await fetch(`${base}/approvals`)).text();
    const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
    if (!pending.approvalRequired || !csrf) throw new Error("Label fingerprint fixture did not require local approval.");
    const response = await fetch(`${base}/approvals/${pending.approvalId}`, { method: "POST", redirect: "manual",
      headers: { Origin: base, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf }) });
    if (response.status !== 303) throw new Error("Label fingerprint approval fixture failed.");
  };
  for (const selector of ["#native-bound", "#aria-bound"]) {
    const action = { type: "interact", pageId: labelTab.pageId, action: "fill", target: { by: "css", value: selector }, text: "must-remain-empty" };
    const pending = await rawCall(action);
    await approveLabelAction(pending);
    if (selector === "#native-bound") {
      await labelPage.locator("#native-tail").evaluate((label) => { label.textContent = label.textContent.replace(/one$/, "two"); });
    } else {
      await labelPage.locator(selector).evaluate((input) => { input.setAttribute("aria-labelledby", "association-second"); });
    }
    const changed = await rawCall({ ...action, approvalId: pending.approvalId });
    if (!changed.approvalRequired || await labelPage.locator(selector).inputValue() !== "") {
      throw new Error(`Changed full label or association reused an old approval: ${selector}`);
    }
  }
  await call({ type: "close_tab", pageId: labelTab.pageId });
  console.log(`PASS: isolated Chromium extension; group isolation, background focus, vision, semantic interactions, native/ARIA labels, hidden native toggles, sensitive fields, label-bound approvals, screenshots, PDF, uploads/downloads, extraction, profiles, handoff, and website denial.`);
} finally {
  await browser?.close().catch(() => undefined);
  companion.kill();
  const expectedPrefix = path.join(os.tmpdir(), "browserpilot-test-");
  if (temp.startsWith(expectedPrefix)) await rm(temp, { recursive: true, force: true }).catch(() => undefined);
}
