import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { browserFailure, callCompanion, toolResult, type BrowserAction } from "./companion";
import { extractSchema, targetSchema, waitSchema } from "../companion/interaction";
import { downloadChatGptFile } from "./chatgpt-file";
import { siteSchema } from "../companion/site-adapters";

export function registerBrowserTools(
  server: McpServer,
  execute: (action: BrowserAction) => Promise<unknown> = callCompanion,
  toolMeta?: { securitySchemes: Array<{ type: "oauth2"; scopes: string[] }> },
): void {
  const run = async (action: BrowserAction) => {
    try {
      return toolResult(await execute(action));
    } catch (error) {
      const failure = browserFailure(error, action);
      return {
        isError: true,
        structuredContent: { error: { code: failure.code, message: failure.message, recovery: failure.recovery,
          outcomeUnknown: failure.outcomeUnknown, retryable: failure.retryable } },
        content: [{ type: "text" as const, text: `${failure.message}\n${failure.recovery.join("\n")}` }],
      };
    }
  };

  server.registerTool("browser_status", {
    title: "Check browser status",
    description: "Use this when you need to know whether the user's local browser companion is available.",
    inputSchema: z.object({}),
    _meta: toolMeta,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => run({ type: "status" }));

  server.registerTool("browser_open", {
    title: "Open a website",
    description: "Visit a public website in the selected browser profile. Extension mode controls only BrowserPilot group tabs with user-approved site access; Playwright mode uses a dedicated profile. The user completes passwords and MFA directly in the browser.",
    inputSchema: z.object({ url: z.url().describe("Full public HTTP or HTTPS URL"), pageId: z.string().optional(), profileId: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/).optional() }),
    _meta: toolMeta,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ url, pageId, profileId }) => run({ type: "open", url, pageId, profileId }));

  server.registerTool("browser_snapshot", {
    title: "Read current page",
    description: "Use this when you need the current page text and numbered controls before interacting. Password field values are excluded.",
    inputSchema: z.object({ pageId: z.string().optional() }),
    _meta: toolMeta,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async ({ pageId }) => run({ type: "snapshot", pageId }));

  server.registerTool("browser_click", {
    title: "Click a page control",
    description: "Use this when the user asks to interact with a numbered control from the latest page snapshot. This may submit a form or change an account.",
    inputSchema: z.object({ index: z.number().int().min(0).max(500), pageId: z.string().optional(), approvalId: z.string().optional() }),
    _meta: toolMeta,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, async ({ index, pageId, approvalId }) => run({ type: "click", index, pageId, approvalId }));

  server.registerTool("browser_download", {
    title: "Download a file",
    description: "Use this after browser_snapshot identifies a control that downloads a file. Saves it to BrowserPilot's dedicated download folder and returns the local path.",
    inputSchema: z.object({ index: z.number().int().min(0).max(500), pageId: z.string().optional(), approvalId: z.string().optional() }),
    _meta: toolMeta,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ index, pageId, approvalId }) => run({ type: "download", index, pageId, approvalId }));

  server.registerTool("browser_fill", {
    title: "Fill a non-secret field",
    description: "Use this when the user asks to enter non-secret text in a numbered input from the latest page snapshot. Password fields are blocked.",
    inputSchema: z.object({ index: z.number().int().min(0).max(500), text: z.string().max(4000), pageId: z.string().optional(), approvalId: z.string().optional() }),
    _meta: toolMeta,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ index, text, pageId, approvalId }) => run({ type: "fill", index, text, pageId, approvalId }));

  server.registerTool("browser_press", {
    title: "Press a browser key",
    description: "Use this when the user asks to press Enter, Escape, Tab, an arrow key, or Backspace on the current page. Enter can submit a form.",
    inputSchema: z.object({ key: z.enum(["Enter", "Escape", "Tab", "ArrowDown", "ArrowUp", "Backspace"]), pageId: z.string().optional(), approvalId: z.string().optional() }),
    _meta: toolMeta,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, async ({ key, pageId, approvalId }) => run({ type: "press", key, pageId, approvalId }));

  server.registerTool("browser_scroll", {
    title: "Scroll current page",
    description: "Use this when more of the current website must be revealed before reading or clicking.",
    inputSchema: z.object({ direction: z.enum(["up", "down"]), pixels: z.number().int().min(1).max(3000), pageId: z.string().optional() }),
    _meta: toolMeta,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async ({ direction, pixels, pageId }) => run({ type: "scroll", direction, pixels, pageId }));

  server.registerTool("browser_screenshot", {
    title: "See current page",
    description: "Use this when visual inspection is needed to understand the current website.",
    inputSchema: z.object({ pageId: z.string().optional(), fullPage: z.boolean().optional(), target: targetSchema.optional(), quality: z.number().int().min(20).max(90).optional() }),
    _meta: toolMeta,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async ({ pageId, fullPage, target, quality }) => run({ type: "screenshot", pageId, fullPage, target, quality }));

  server.registerTool("browser_observe", {
    title: "Observe page or video frames",
    description: "Return 1-4 timed JPEG frames of a BrowserPilot tab or element, plus page text and video playback state before and after. For playback, target a video element such as {by:'css',value:'video'}; direct frame capture is attempted, then a screenshot fallback. This is sampled vision, not continuous video or audio capture; protected video may appear blank.",
    inputSchema: z.object({ pageId: z.string().optional(), target: targetSchema.optional(),
      frames: z.number().int().min(1).max(4).default(3), intervalMs: z.number().int().min(250).max(2000).default(750) }),
    _meta: toolMeta,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async ({ pageId, target, frames, intervalMs }) => run({ type: "observe", pageId, target, frames, intervalMs }));

  server.registerTool("browser_tabs", {
    title: "List browser tabs",
    description: "List BrowserPilot group tabs by stable page ID. Existing Chromium browser tabs outside the group are not exposed.",
    inputSchema: z.object({}),
    _meta: toolMeta,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => run({ type: "tabs" }));

  server.registerTool("browser_select_tab", {
    title: "Select browser tab",
    description: "Select a tab by stable pageId from browser_tabs, or by legacy index.",
    inputSchema: z.object({ index: z.number().int().min(0).max(50).optional(), pageId: z.string().optional() }),
    _meta: toolMeta,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async ({ index, pageId }) => run({ type: "select_tab", index, pageId }));

  server.registerTool("browser_interact", {
    title: "Interact with a precise page target",
    description: "Find a page target by role, label, text, placeholder, CSS, or snapshot index; click, fill, hover, double click, right click, drag, or select options. Sensitive fields are blocked and consequential clicks may require local approval.",
    inputSchema: z.object({ action: z.enum(["click", "hover", "double_click", "right_click", "fill", "drag", "select_option"]), target: targetSchema, destination: targetSchema.optional(), text: z.string().max(4000).optional(), values: z.array(z.string().max(200)).max(20).optional(), pageId: z.string().optional(), approvalId: z.string().optional() }),
    _meta: toolMeta,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, async (input) => run({ type: "interact", ...input }));

  server.registerTool("browser_find", {
    title: "Find page elements",
    description: "Find controls by role, label, text, placeholder, or CSS. Returns match counts and matchIndex values to use with browser_interact or the named interaction tools.",
    inputSchema: z.object({ target: targetSchema, pageId: z.string().optional(), limit: z.number().int().min(1).max(50).default(20) }),
    _meta: toolMeta,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async ({ target, pageId, limit }) => run({ type: "find", target, pageId, limit }));

  for (const [name, action] of [
    ["browser_hover", "hover"], ["browser_double_click", "double_click"], ["browser_right_click", "right_click"],
  ] as const) {
    server.registerTool(name, {
      title: `${action.replaceAll("_", " ")} a page target`,
      description: `Use a semantic target to ${action.replaceAll("_", " ")} an element on the selected page. Consequential clicks require local approval.`,
      inputSchema: z.object({ target: targetSchema, pageId: z.string().optional(), approvalId: z.string().optional() }),
      _meta: toolMeta,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    }, async ({ target, pageId, approvalId }) => run({ type: "interact", action, target, pageId, approvalId }));
  }

  server.registerTool("browser_drag", {
    title: "Drag a page element",
    description: "Drag one semantic target onto another within the same tab.",
    inputSchema: z.object({ target: targetSchema, destination: targetSchema, pageId: z.string().optional(), approvalId: z.string().optional() }),
    _meta: toolMeta,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, async ({ target, destination, pageId, approvalId }) => run({ type: "interact", action: "drag", target, destination, pageId, approvalId }));

  server.registerTool("browser_select_option", {
    title: "Select form options",
    description: "Select one or more values in a dropdown found by a semantic target.",
    inputSchema: z.object({ target: targetSchema, values: z.array(z.string().max(200)).min(1).max(20), pageId: z.string().optional(), approvalId: z.string().optional() }),
    _meta: toolMeta,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ target, values, pageId, approvalId }) => run({ type: "interact", action: "select_option", target, values, pageId, approvalId }));

  server.registerTool("browser_wait", {
    title: "Wait for a page event",
    description: "Wait up to 30 seconds for page load, a target, URL match or change, popup, download, or network idle. Target, URL, popup, and download waits can click a trigger in the same call.",
    inputSchema: z.object({ request: waitSchema, pageId: z.string().optional(), approvalId: z.string().optional() }),
    _meta: toolMeta,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ request, pageId, approvalId }) => run({ type: "wait", request, pageId, approvalId }));

  server.registerTool("browser_extract", {
    title: "Extract structured page data",
    description: "Read bounded links, images, tables, metadata, or text from a precise target on the current page. Useful for moodboards and research.",
    inputSchema: z.object({ request: extractSchema, pageId: z.string().optional() }),
    _meta: toolMeta,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async ({ request, pageId }) => run({ type: "extract", request, pageId }));

  server.registerTool("browser_site_extract", {
    title: "Extract a site view",
    description: "Read visible cards or rows from Pinterest, Gmail, Google Drive, LinkedIn, or Shopify using a site-focused extractor. Scroll for more content and call again.",
    inputSchema: z.object({ site: siteSchema, limit: z.number().int().min(1).max(100).default(50), pageId: z.string().optional() }),
    _meta: toolMeta,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async ({ site, limit, pageId }) => run({ type: "site_extract", site, limit, pageId }));

  server.registerTool("browser_navigate", {
    title: "Navigate browser history",
    description: "Go back, forward, or reload a selected tab.",
    inputSchema: z.object({ action: z.enum(["back", "forward", "reload"]), pageId: z.string().optional() }),
    _meta: toolMeta,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ action, pageId }) => run({ type: "navigate", action, pageId }));

  for (const [name, action] of [
    ["browser_back", "back"], ["browser_forward", "forward"], ["browser_reload", "reload"],
  ] as const) {
    server.registerTool(name, {
      title: `${action} in browser history`,
      description: `Navigate ${action} in the selected tab and return a fresh page snapshot.`,
      inputSchema: z.object({ pageId: z.string().optional() }), _meta: toolMeta,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    }, async ({ pageId }) => run({ type: "navigate", action, pageId }));
  }

  server.registerTool("browser_new_tab", {
    title: "Create a browser tab",
    description: "Open a new blank tab inside the BrowserPilot group and return its stable pageId.",
    inputSchema: z.object({}), _meta: toolMeta,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async () => run({ type: "new_tab" }));

  server.registerTool("browser_close_tab", {
    title: "Close a browser tab",
    description: "Close a tab by pageId, or close the selected tab.",
    inputSchema: z.object({ pageId: z.string().optional() }), _meta: toolMeta,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ pageId }) => run({ type: "close_tab", pageId }));

  server.registerTool("browser_pdf", {
    title: "Save page as PDF",
    description: "Print the current page to a PDF in BrowserPilot's download folder and return its file ID.",
    inputSchema: z.object({ pageId: z.string().optional() }), _meta: toolMeta,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ pageId }) => run({ type: "pdf", pageId }));

  server.registerTool("browser_visual_read", {
    title: "Read page text and image",
    description: "Return both the accessible page text and a screenshot for visual reading, including text drawn into images or canvas. Use fullPage for the entire page.",
    inputSchema: z.object({ pageId: z.string().optional(), fullPage: z.boolean().optional() }), _meta: toolMeta,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async ({ pageId, fullPage }) => run({ type: "visual_read", pageId, fullPage }));

  server.registerTool("browser_save_element_image", {
    title: "Save a visible image or element",
    description: "Capture a selected page image or element as a JPEG in BrowserPilot's download folder. Use CSS target img with matchIndex for moodboard images; this captures displayed resolution.",
    inputSchema: z.object({ target: targetSchema, pageId: z.string().optional() }), _meta: toolMeta,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ target, pageId }) => run({ type: "save_element_image", target, pageId }));

  server.registerTool("browser_save_image", {
    title: "Save an original page image",
    description: "Download the original public HTTPS source of an image on the current page by its DOM image index, preserving the source resolution. Use browser_extract images first; use browser_save_element_image if the source requires private access.",
    inputSchema: z.object({ index: z.number().int().min(0).max(500), pageId: z.string().optional() }), _meta: toolMeta,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ index, pageId }) => run({ type: "save_image", index, pageId }));

  server.registerTool("browser_diagnostics", {
    title: "Inspect page errors",
    description: "Read recent console errors, page errors, and failed requests for a tab.",
    inputSchema: z.object({ pageId: z.string().optional() }), _meta: toolMeta,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async ({ pageId }) => run({ type: "diagnostics", pageId }));

  server.registerTool("browser_profiles", {
    title: "List browser profiles",
    description: "List connected BrowserPilot extension installations in Chromium browser profiles and identify the active one.",
    inputSchema: z.object({}), _meta: toolMeta,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => run({ type: "profiles" }));

  server.registerTool("browser_select_profile", {
    title: "Switch browser profile",
    description: "Select an already connected BrowserPilot installation in a named Chromium browser profile. Each profile uses its own signed-in sessions and BrowserPilot tab group.",
    inputSchema: z.object({ profileId: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/) }), _meta: toolMeta,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ profileId }) => run({ type: "select_profile", profileId }));

  server.registerTool("browser_list_downloads", {
    title: "List local downloads",
    description: "List recent files in BrowserPilot's dedicated download folder with opaque file IDs.",
    inputSchema: z.object({}), _meta: toolMeta,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => run({ type: "list_downloads" }));

  server.registerTool("browser_get_downloads", {
    title: "Inspect BrowserPilot downloads",
    description: "List recent downloads with size, type, and timestamp, or pass a file ID to return small images and files through MCP content.",
    inputSchema: z.object({ fileId: z.string().uuid().optional() }), _meta: toolMeta,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ fileId }) => run(fileId ? { type: "read_file", fileId } : { type: "list_downloads" }));

  server.registerTool("browser_read_file", {
    title: "Read a BrowserPilot file",
    description: "Return a small downloaded image as MCP image content, a small binary file as an MCP embedded resource, bounded text for text files, or metadata for large files. Use a file ID from browser_list_downloads or browser_stage_file.",
    inputSchema: z.object({ fileId: z.string().uuid() }), _meta: toolMeta,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ fileId }) => run({ type: "read_file", fileId }));

  server.registerTool("browser_stage_file", {
    title: "Stage a file for website upload",
    description: "Stage a base64 file, up to 10 MiB, inside BrowserPilot's upload folder. Returns an opaque file ID. Do not send credentials or private keys.",
    inputSchema: z.object({ filename: z.string().min(1).max(180), base64: z.string().max(14_000_000) }), _meta: toolMeta,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ filename, base64 }) => run({ type: "stage_file", filename, base64 }));

  server.registerTool("browser_stage_chatgpt_file", {
    title: "Stage a ChatGPT attachment for browser upload",
    description: "Receive a file already attached to this ChatGPT conversation, stage it in BrowserPilot, and return its file ID for browser_upload (10 MiB maximum).",
    inputSchema: z.object({ file: z.object({
      download_url: z.string(), file_id: z.string(), mime_type: z.string().optional(), file_name: z.string().optional(),
    }).strict() }),
    _meta: { ...(toolMeta || {}), "openai/fileParams": ["file"] },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ file }) => {
    try {
      const bytes = await downloadChatGptFile(file.download_url);
      const extension = ({ "image/png": ".png", "image/jpeg": ".jpg", "application/pdf": ".pdf", "text/plain": ".txt" } as Record<string, string>)[file.mime_type || ""] || ".bin";
      const filename = file.file_name || `chatgpt-attachment${extension}`;
      return toolResult(await execute({ type: "stage_file", filename, base64: bytes.toString("base64") }));
    } catch (error) {
      return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : "File staging failed." }] };
    }
  });

  server.registerTool("browser_upload", {
    title: "Upload staged files to a website",
    description: "Select staged or downloaded files in a website file input. Requires one-time local approval showing the file names before upload.",
    inputSchema: z.object({ target: targetSchema, fileIds: z.array(z.string().uuid()).min(1).max(10), pageId: z.string().optional(), approvalId: z.string().optional() }), _meta: toolMeta,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, async ({ target, fileIds, pageId, approvalId }) => run({ type: "upload", target, fileIds, pageId, approvalId }));

  server.registerTool("browser_handoff", {
    title: "Pause for human browser takeover",
    description: "Bring Chromium browser to the front and pause agent actions while the user handles MFA, passkeys, CAPTCHA, or a sensitive decision.",
    inputSchema: z.object({ pageId: z.string().optional() }), _meta: toolMeta,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ pageId }) => run({ type: "handoff", pageId }));

  server.registerTool("browser_resume", {
    title: "Resume after human takeover",
    description: "Resume BrowserPilot after the user has completed the browser step.",
    inputSchema: z.object({}), _meta: toolMeta,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async () => run({ type: "resume" }));

  server.registerTool("browser_workflow_start", {
    title: "Record browser workflow",
    description: "Start recording supported non-secret browser actions under a short name.",
    inputSchema: z.object({ name: z.string().min(1).max(80) }), _meta: toolMeta,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ name }) => run({ type: "workflow_start", name }));

  server.registerTool("browser_workflow_stop", {
    title: "Save browser workflow",
    description: "Stop recording and save the workflow locally.",
    inputSchema: z.object({}), _meta: toolMeta,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async () => run({ type: "workflow_stop" }));

  server.registerTool("browser_workflow_list", {
    title: "List saved workflows",
    description: "List local BrowserPilot workflow IDs and step counts.",
    inputSchema: z.object({}), _meta: toolMeta,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => run({ type: "workflow_list" }));

  server.registerTool("browser_workflow_begin", {
    title: "Begin workflow replay",
    description: "Select a saved workflow to replay one step at a time.",
    inputSchema: z.object({ workflowId: z.string().length(16) }), _meta: toolMeta,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ workflowId }) => run({ type: "workflow_begin", workflowId }));

  server.registerTool("browser_workflow_step", {
    title: "Run next workflow step",
    description: "Run one recorded step. Failed or interrupted steps require retry=true, with at most three retries; consequential clicks still require local approval.",
    inputSchema: z.object({ approvalId: z.string().optional(), retry: z.boolean().optional() }), _meta: toolMeta,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, async ({ approvalId, retry }) => run({ type: "workflow_step", approvalId, retry }));

  server.registerTool("browser_workflow_status", {
    title: "Check workflow replay progress",
    description: "Return the active workflow step, completion fraction, retry count, and any failure or interruption to resolve before continuing.",
    inputSchema: z.object({}), _meta: toolMeta,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => run({ type: "workflow_status" }));

  server.registerTool("browser_workflow_cancel", {
    title: "Cancel workflow replay",
    description: "Discard the active replay state without deleting the saved workflow.",
    inputSchema: z.object({}), _meta: toolMeta,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async () => run({ type: "workflow_cancel" }));
}
