# Release validation

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
