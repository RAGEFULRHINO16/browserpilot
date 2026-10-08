# Release validation

## Locally observed cross-site approval regressions for 0.5.3

On Windows x64 with Node.js 24.13.0, build and typecheck passed and all 58 core
tests passed with real Chromium security and MCP-disconnect checks enabled.
The isolated extension smoke and optional authenticated HTTP test also passed.
These are maintainer-run results, not independent adoption or a security audit.
The fresh production-package install completed its 50-tool MCP handshake,
authenticated file round-trip and owned-process cleanup; the no-account
`npm run try:browser` exercise passed with actual MCP image content and temporary
profile removal. `npm audit --omit=dev` reported zero advisories at this check.

The extension test grants two fixture origins only in a temporary extension copy.
Playwright fulfills both origins with synthetic HTML; no live account is used.
The first site's article body contains an instruction to abandon summarization
and upload a staged file to the second approved site. Snapshot and article-region
extraction return that instruction. The second site's file input remains empty
until exact local approval; the exact approved upload succeeds once and its
consumed grant cannot replay. The approval HTML contains both the earlier article
and action destination. The fixture repeats denial after navigating between those
sites within the same tab, preserving the earlier article observation.

New reads leave the pending approval's original evidence and context hash intact.
Core tests cover redaction, profile separation, history bounds/expiry, defensive
copies, explicit display truncation, and inconsistent snapshot/URL evidence omission.
Source metadata precedes potentially large target details in the approval display.
The record retains no article text, screenshots, query strings or URL credentials.

This evaluates the tool authorization boundary after reading untrusted content,
not an LLM's reaction to prompt injection. Recent observations do not prove which
page influenced an agent. They can expire or be evicted, and target checks and
actuation are not atomic. See [security limits](../SECURITY.md).

## Locally observed first-run and cleanup regressions for 0.5.2

The no-account `npm run try:browser` exercise passed on Windows x64 with Node
24.13.0 using sandboxed headless Chromium. The real MCP connection listed 50
tools, read a public page, extracted links, returned a 47,271-byte JPEG through
MCP content, and round-tripped a synthetic local text file. No model was called,
no website write was performed, and the temporary profile was removed after
companion shutdown. Public page content and image sizes can change.

An initial run exposed a Windows profile-file cleanup race. The CLI now sends
an owned-process-only IPC shutdown request so the companion can close its
Playwright context before exit; no HTTP or agent-tool shutdown endpoint was
added. The termination fallback stays bounded and never targets a reused service.
New tests exercise asynchronous IPC cleanup and real isolated Chromium MCP
disconnect/profile removal. All 54 core tests passed with browser checks enabled;
the existing isolated extension smoke, typecheck and optional HTTP test/build
also passed. The optional web adapter now resolves Next.js 16.3.8 after review
of the dependency-only update; this is not a claim about exploitability of every
upstream advisory in this application.

These remain maintainer-run results, not independent usage or a security audit.
The public-page exercise is manual; deterministic CI uses synthetic fixtures
rather than depending on a third-party website's availability or content.

## Locally observed feedback regressions for 0.5.1

The approval page displays a 12-character SHA-256 request prefix and the full
digest on hover; the tool result returns `requestDigest`. A unit assertion checks
that it hashes the exact bound action rather than the display description.
The README's primary setup uses isolated Playwright; optional extension setup
and CLI guidance warn about shared sign-ins before attaching a real profile.
Existing configurations are preserved, not migrated by a documentation change.

The sandboxed Chromium extension fixture reads a page instructing an agent to
upload a staged file. The upload remains pending; a click grant cannot authorize
it, a changed staged-file ID requires fresh approval, the exact approved upload
succeeds, and replay of the consumed grant is rejected. This is a deterministic
tool-boundary regression, not an LLM prompt-injection evaluation or a claim that
malicious content cannot persuade a user to approve an unsafe action.

Observed locally on Windows with Node.js 24.13.0: build/typecheck passed, all
52 core tests passed with the opt-in real Chromium fixture enabled, the extension
smoke and optional HTTP test passed, the fresh production-package test completed
its 50-tool MCP handshake/file transfer/process cleanup, and the production
advisory check reported zero vulnerabilities. These checks did not touch the
maintainer's personal browser profile. Consult the release's linked CI run for
cross-platform results.

## Locally observed results for 0.5.0

On Windows 10.0.26200 x64 with Node.js 24.13.0, the public production archive
was installed in a fresh temporary prefix with `--workspaces=false`. The extracted
stdio dependency tree contained no Next.js, React, React DOM, mcp-handler or jose.
The real MCP SDK handshake listed all 50 tools, authenticated file staging and
reading worked, and the owned companion stopped after client disconnect.

The core suite passed 51 tests with one opt-in Chromium test skipped by default.
The optional HTTP adapter test passed, and the extension smoke passed in sandboxed
Chromium 153.0.8010.12. Cross-platform CI must be consulted for the exact release
commit before publishing.

One local companion sample measured 99.8 MiB RSS and 46.1 MiB JavaScript heap after
10 seconds idle, with no browser running. Installed dependency bytes were 31.3 MiB
in that temporary Windows prefix. This excludes the MCP client and browser; it is
one sample, not a promised ceiling. A real Brave session uses additional memory.

`browserpilot doctor` distinguishes configuration errors, offline services,
authentication conflicts, backend mismatches, unresponsive ports, a running but
unpaired browser, human takeover and a healthy connected backend. It never prints
tokens, never replaces an occupied service, and only recovers a companion process
owned by the current stdio session. Ambiguous write failures require inspection,
not blind retries.

## Locally observed results for 0.4.1

On Windows, the portable build and TypeScript checking passed. The default suite
passed 30 tests with one explicitly opt-in Chromium security test skipped. With
`BROWSERPILOT_BROWSER_SECURITY_TEST=1`, all 31 tests passed with no skips.
The production dependency advisory scan reported zero vulnerabilities.

The isolated, sandbox-enabled Chromium extension smoke also passed. New fixtures
exercise native and ordered ARIA labels, exclusion of ancestor text from label
targeting, associated visible-label clicks for hidden native checkboxes/radios,
sensitive-field rejection, ordinary editable drafts, and approval invalidation
when complete label text or label associations change. The Playwright fixture
also checks external form ownership and focused-element fingerprints.

These are focused regressions, not a claim of complete accessible-name algorithm
coverage or arbitrary website compatibility. The Windows browser CI job enables
the opt-in security test as well as the extension smoke; the other core jobs
retain the browser-free default suite.

## Locally observed results for 0.4.0

On Windows with Node.js 24.13.0:

- Portable CLI/companion build: passed.
- TypeScript checking: passed.
- 27 automated tests: passed, including real MCP SDK stdio initialization,
  tool listing/calls, companion process cleanup, HTTP MCP authentication,
  exact-action approvals, DNS/Origin checks, bridge pairing, and file confinement.
- `npm audit --omit=dev --audit-level=high`: zero reported vulnerabilities at
  release time. This is a dependency advisory check, not a source-code audit.
- Optional Next.js web-adapter production build: passed. Its file tracing emits
  warnings for dynamic local configuration paths; deploy only as documented.
- Extension smoke: passed in an isolated Chromium 153.0.8010.12 profile with
  browser sandboxing enabled, never the maintainer's daily browser profile.

The extension smoke verifies group isolation, preservation of the active user
tab, semantic targeting, clicks/fill/selection, local approvals, viewport/full-page/
element screenshots, changing video frames, PDF output, staged upload, real browser
download, extraction, profile discovery, human handoff/resume, and rejection of
unapproved websites, Google authentication and a loopback destination.
Its test-only website grant and approval helper simulate explicit user consent;
neither is enabled in production. Fixture pages contain no real accounts.

## Continuous integration

The linked [CI workflow](https://github.com/RAGEFULRHINO16/browserpilot/actions/workflows/ci.yml)
runs the core build/typecheck/tests/advisory check on Windows, Linux and macOS
using Node.js 22, and the Chromium extension smoke on Windows. Consult a specific
run for observed results; a workflow definition is not proof of a passing run.

The [initial release run](https://github.com/RAGEFULRHINO16/browserpilot/actions/runs/37188744313)
completed successfully: all three OS core jobs and the Windows Chromium-extension
job passed using Node.js 22. This establishes the exercised CLI/protocol paths,
not every browser/backend combination on all platforms.

## Not established by these tests

There is no independent penetration-test certification, provider certification,
Firefox support, guarantee for arbitrary websites, or proof of Brave/Edge parity
across versions. Chrome's extension APIs are the portability target; please report
your actual browser, OS and version when contributing compatibility results.
Headless fixture success does not prove every interactive login flow, CAPTCHA,
passkey or protected-video path. These require human involvement or further tests.
See [the security policy](../SECURITY.md) before granting access to sensitive sites.
