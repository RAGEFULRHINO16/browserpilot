# Contributing

Start with a reproducible issue or a small, focused pull request. Include the
browser/OS, Node version, backend, tool request (without credentials) and expected
behavior. Please do not include real account data in fixtures.

```sh
npm ci
npm run build
npm run typecheck
npm test
npx playwright install chromium
npm run test:extension
```

The unit and MCP tests use temporary configuration, random credentials and
unused loopback ports. The extension smoke uses an isolated Chromium profile.
It never opens the contributor's daily profile. The smoke's local approval
fixture simulates a person approving each exact action; it is not a production
approval bypass.

Good first contributions: improve accessible-name matching with small fixtures;
document a tested client integration; add browser-version regressions; expand
safe extraction adapters without adding arbitrary evaluation tools. Larger
changes should have an issue describing compatibility and security effects.

AI-assisted contributions are welcome. The submitter must understand the change,
verify it, disclose substantial assistance, and own follow-up fixes. Generated
reports without a reproduction and sweeping unreviewable changes are not useful.

Use existing naming, strict TypeScript and bounded inputs. Every additional
write-capable interaction must preserve local approval and profile/tab checks.
