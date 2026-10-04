# BrowserPilot

**Your browser. Your sessions. Your choice of agent.**

[![CI](https://github.com/RAGEFULRHINO16/browserpilot/actions/workflows/ci.yml/badge.svg)](https://github.com/RAGEFULRHINO16/browserpilot/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-335c48)](LICENSE)

BrowserPilot is a local browser-control engine for agents that speak
[Model Context Protocol](https://modelcontextprotocol.io/). It provides 50 tools
for reading and interacting with websites through your existing Chromium browser
profile or an isolated Playwright profile. It has no required hosted service,
provider API key, paid credits or BrowserPilot subscription. Your chosen agent
provider may have its own charges.

The extension starts with public websites **unapproved**. You grant websites
from its popup, and actions such as clicks, typing, selection, upload and download
triggers require a one-use approval on your PC. Read the [security boundaries](SECURITY.md)
before connecting a profile with sensitive accounts. This is an early public
release with AI-assisted development, not an independently audited security product.

The [latest release](https://github.com/RAGEFULRHINO16/browserpilot/releases/latest)
includes a compiled npm-format archive and SHA-256 checksum. It is not published
to the npm registry; the source instructions below remain the reproducible path.

## What it does

| Capability | Controls |
| --- | --- |
| Read and find | Page snapshots, accessible/semantic targets, text, tables, links, metadata, site-focused extraction |
| Interact | Click, hover, double/right click, drag, select options, non-secret fill and keyboard input |
| See | Viewport/full-page/element screenshots, PDF, bounded video frame observation and model-assisted visual reading |
| Navigate | Stable page IDs, tabs, history, reload, element/page/popup/download/network-idle waits |
| Transfer | Staged uploads, bounded download/image/file results through MCP content |
| Coordinate | Named profiles, human handoff, diagnostics, recording and resumable step-by-step replay |

Only BrowserPilot group tabs are exposed by the extension. Ordinary controls and
screenshots stay in the background; human handoff deliberately focuses the group.
The group shares your profile's sign-ins and is not a security sandbox. Passwords,
MFA and passkeys are handled directly by you. Video observation samples frames;
it is not live streaming or audio transcription, and protected video can be blank.

## Install from source

Requires Node.js 22+ and Git. The CLI and MCP tests run on Windows, macOS and
Linux in CI. The extension uses Chromium APIs available in Chrome, Brave and Edge;
see [validation](docs/VALIDATION.md) for the versions actually tested.

```sh
git clone https://github.com/RAGEFULRHINO16/browserpilot.git
cd browserpilot
npm ci
npm run build
node dist/cli/index.js init
node dist/cli/index.js pair
```

1. Open your browser's extensions page, enable developer mode, choose **Load
   unpacked**, and select the repository's `extension` directory.
2. Open BrowserPilot's extension popup. Paste the JSON from `pair` into **Local
   pairing code**, then select **Save and connect**. Keep that JSON private.
3. Enter each website you want your agent to use and choose **Approve this website**.
4. Connect your MCP client using the configuration below. The client starts the
   local companion when needed. Keep your browser running.

Configuration is generated in your OS user data directory, not in the repository.
Use `node dist/cli/index.js status` to check connectivity. For an already occupied
port, initialize a separate data directory with `init --port 8875`. Custom settings
are documented in [configuration](docs/CONFIGURATION.md).

### Connect any local MCP client

Use the absolute path to your built CLI. No provider-specific credential is needed:

```json
{
  "mcpServers": {
    "browserpilot": {
      "command": "node",
      "args": ["/absolute/path/browserpilot/dist/cli/index.js", "mcp"]
    }
  }
}
```

On Windows, use forward slashes or escaped backslashes in JSON. This configuration
fits clients that use the `mcpServers` convention, including Claude Desktop.
For Codex CLI, register the same stdio command:

```sh
codex mcp add browserpilot -- node /absolute/path/browserpilot/dist/cli/index.js mcp
```

These are protocol integrations, not vendor endorsements. Hosted chats such as
ChatGPT cannot reach a PC's stdio process directly; their remote MCP connection
requires a separate supported tunnel/authentication setup. The public release's
optional HTTP endpoint is authenticated and loopback-only; it does not publish
your browser on the internet. See [client integrations](docs/CLIENTS.md).

### Use an isolated Playwright profile instead

Initialize a fresh data directory with `init --backend playwright --headless`, then
install Chromium once using `npx playwright install chromium`. Omit `--headless`
if you need to sign in directly or use human handoff. The profile is separate from
your daily browser. Chromium sandboxing stays enabled.

## Approve actions

Tools return `approvalRequired`, `approvalId` and a local `approvalUrl` when an
action needs confirmation. Review the exact request on that page and select
**Approve once**, then repeat the tool request with its `approvalId`. Changed
URLs, targets or entered text invalidate the approval. The local approval page
is never included as a remotely controllable agent tab.

Files selected for upload must first be staged with `browser_stage_file` or
downloaded into the configured BrowserPilot folder. File IDs do not grant access
to arbitrary paths. Extension downloads use your browser's default Downloads
folder plus `BrowserPilot`; configure the companion to match if yours differs.
MCP file content does not automatically create a file in a hosted chat sandbox.

## Develop and contribute

```sh
npm run build
npm run typecheck
npm test
npx playwright install chromium
npm run test:extension
```

[Architecture](docs/ARCHITECTURE.md) explains the boundaries.
[Contributing](CONTRIBUTING.md) lists useful first contributions.
[Roadmap](docs/ROADMAP.md) tracks unsupported features and priorities.
[Security](SECURITY.md) covers reporting and known limitations.

Maintained by [Magarish Muhunthan](https://github.com/RAGEFULRHINO16).
Released under the [MIT license](LICENSE). We welcome reproducible feedback and
independent contributors; no adoption numbers or program endorsements are implied.
