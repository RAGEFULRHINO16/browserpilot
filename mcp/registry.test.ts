import assert from "node:assert/strict";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/server";
import { registerBrowserTools } from "../lib/tools";
import type { BrowserAction } from "../lib/companion";

type Tool = { inputSchema: { parse(value: unknown): unknown }; annotations?: { readOnlyHint?: boolean } };
test("shared MCP registry preserves controls and forwards one-time approval IDs", async () => {
  const tools = new Map<string, { schema: Tool; run(input: unknown): Promise<unknown> }>();
  const actions: BrowserAction[] = [];
  const stub = { registerTool(name: string, schema: Tool, handler: (input: unknown) => Promise<unknown>) {
    assert.equal(tools.has(name), false, `Duplicate tool: ${name}`);
    tools.set(name, { schema, run: handler });
  } } as unknown as McpServer;
  registerBrowserTools(stub, async (action) => { actions.push(action); return { okay: true }; });
  assert.equal(tools.size, 50);
  for (const name of ["browser_observe", "browser_get_downloads", "browser_stage_chatgpt_file", "browser_workflow_step", "browser_handoff", "browser_profiles"]) assert.ok(tools.has(name), name);
  assert.equal(tools.get("browser_open")?.schema.annotations?.readOnlyHint, false);
  const approvalId = "a".repeat(32);
  for (const [name, input] of [
    ["browser_fill", { index: 1, text: "hello", approvalId }],
    ["browser_drag", { target: { by: "css", value: "#from" }, destination: { by: "css", value: "#to" }, approvalId }],
    ["browser_select_option", { target: { by: "css", value: "select" }, values: ["one"], approvalId }],
  ] as const) {
    const tool = tools.get(name)!;
    await tool.run(tool.schema.inputSchema.parse(input));
    assert.equal(actions.at(-1)?.approvalId, approvalId, name);
  }
  const screenshot = tools.get("browser_screenshot")!;
  assert.throws(() => screenshot.schema.inputSchema.parse({ quality: 200 }));
});
