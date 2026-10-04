# Roadmap

The current release prioritizes a reproducible local install, standard MCP
transport, conservative actions and preservation of the complete control set.

Next work is driven by independent users and reproducible issues:

1. Exercise more Chrome, Brave and Edge versions with small regression fixtures.
2. Improve pairing/status UX and scoped approvals without trusting website labels.
3. Improve accessible names, iframe support and site adapters with explicit tests.
4. Measure further runtime reductions; the optional web adapter was separated in 0.5.0.
5. Explore Firefox support after its debugger and group API differences are mapped.
6. Strengthen network isolation and atomic action targeting where browser APIs allow.

Windows is the first locally verified platform. Cross-platform CLI and protocol
tests run in CI; support is reported from actual results, not assumed parity.
No feature date, independent audit or maintainer-program acceptance is promised.
