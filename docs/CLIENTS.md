# MCP client connections

The recommended interface is standard MCP over stdio:

```json
{"mcpServers":{"browserpilot":{"command":"node","args":["/absolute/path/browserpilot/dist/cli/index.js","mcp"]}}}
```

Use your client's normal MCP settings and allow tools intentionally. The same
50-tool registry is used for every client. BrowserPilot does not select or call
a language model. Compatible MCP clients may handle image/resource content
differently; verify their support for the artifacts you want to use.

For Codex: `codex mcp add browserpilot -- node /absolute/path/browserpilot/dist/cli/index.js mcp`.
For Claude Desktop and clients following its config convention, use `mcpServers`
above. BrowserPilot has not undergone provider certification.

## Optional local streamable HTTP

Set independent `BROWSERPILOT_COMPANION_TOKEN`,
`BROWSERPILOT_COMPANION_URL=http://127.0.0.1:8765`, and
`BROWSERPILOT_MCP_TOKEN` values in a private `.env.local` (or environment).
Run `npm run build:web` then `npm start`. Your client connects to
`http://127.0.0.1:3000/mcp` with `Authorization: Bearer <MCP token>`.
Start the companion with matching configuration using `browserpilot start`.
Tokens are never included in the URL.

The adapter rejects public Host headers and foreign Origin headers. It has no
anonymous mode. A hosted chat needs supported remote authentication and transport
beyond this local adapter; arbitrary reverse proxies are not a secure deployment
recipe. Existing personal BrowserPilot tunnel installations are separate from
this portable release.
