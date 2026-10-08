# Security policy

BrowserPilot controls browser sessions that may contain authenticated accounts.
Version 0.5.x is an early public release, not an independently certified product.

Report a vulnerability privately through GitHub's **Report a vulnerability**
button in this repository's Security tab. Include a minimal reproduction,
affected version and expected boundary. Do not post session tokens or personal
data in public issues. Reports are reviewed by the maintainer; there is no
paid bounty or guaranteed response SLA.

## Boundaries

- The companion binds to IPv4 loopback and requires a random bearer token.
  Host and Origin checks protect both the API and local approval page against
  cross-origin calls and DNS rebinding of the HTTP endpoint.
- The extension uses an independently derived local pairing key. Public website
  permissions are optional and must be granted from its popup. Control is limited
  to the BrowserPilot tab group. Removing a website grant detaches its debugger.
- Clicks, text entry, keyboard dispatches, drag/drop, selection, upload and download
  triggers require a short-lived, one-use local approval. The approval binds the
  exact request, profile, tab, current URL and target fingerprint. Website labels
  cannot turn off the gate. Replays use the same gates.
- Approvals also show recent page-read metadata from the active profile, including
  earlier pages before navigation to the action destination. This server-owned
  history is contextual evidence, not proof of what caused the agent's decision.
  It is frozen when an approval is prepared; new reads do not rewrite that record.
  History retains at most 64 records globally, displays the latest eight per
  profile, and expires after ten minutes. URLs omit credentials, query and fragment
  and are limited to 512 characters. No page text or images are stored in history.
  The separate context hash covers the request and frozen displayed context.
- Common password, one-time code and payment inputs are blocked. This is heuristic
  field detection; websites can implement unusual inputs. Review entered text and
  complete authentication directly in your browser through human handoff.
- Files are confined to configured staging/download directories, referenced by
  opaque IDs, bounded in size, and checked against symlink escapes. Server-side
  HTTPS file downloads validate and pin DNS and recheck redirects.
- There are no tools for arbitrary JavaScript, shell commands, cookies or browser
  storage. Page text, screenshots and console errors can still reveal personal
  information to the agent provider you selected. Read access is meaningful access.

## Limits

A tab group shares the browser profile's cookies and accounts. It is not a
profile sandbox. Use a separate browser profile for sensitive work. Browsed pages
and agent instructions are untrusted: local approvals reduce accidental writes
but do not establish that an action is wise or authorized by an account owner.

The browser can make its own requests and redirects. Website permissions and
public-address checks do not provide firewall-level network isolation or pin the
browser's DNS connections. Use OS network restrictions if that boundary matters.
The DOM can change between approval and interaction; stable fingerprints and
obscured-target checks reduce that race but cannot eliminate a hostile page.
Observation history may be absent, expired, evicted, or omitted when the observed
URL changes during a read. Snapshot and navigation reads, semantic find/extraction,
vision and saved page/image artifacts are tracked; mutation-returned snapshots
and previously read local files are not a complete information-flow trace.
The final element check and interaction are not an atomic transaction. BrowserPilot
does not claim to prove user intent or prevent all prompt injection.

Anyone running as your OS user can normally read your local configuration.
Configuration uses restrictive POSIX modes; Windows relies on your user profile's
ACLs. Do not expose loopback services with an unprotected proxy or tunnel. Stdio
is the recommended transport; the optional HTTP adapter also requires a separate
bearer token and rejects public Host headers.
