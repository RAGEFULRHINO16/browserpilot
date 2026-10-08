import { McpServer } from "@modelcontextprotocol/server";
import { registerBrowserTools } from "../lib/tools";
import type { BrowserAction } from "../lib/companion";

export function createBrowserPilotServer(execute?: (action: BrowserAction) => Promise<unknown>): McpServer {
  const server = new McpServer({ name: "browserpilot", version: "0.5.3" }, { capabilities: { tools: {} } });
  registerBrowserTools(server, execute);
  return server;
}
