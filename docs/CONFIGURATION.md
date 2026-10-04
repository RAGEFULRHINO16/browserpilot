# Local configuration

`browserpilot init` generates random credentials and preserves an existing
configuration. `setup` is an alias. Initial options are `--port NUMBER`,
`--backend extension|playwright`, `--headless`, and `--browser-path PATH`.
To make a different installation, set `BROWSERPILOT_DATA_DIR` before initializing.
Initial options do not silently rewrite an existing config or rotate credentials.

| OS | Default config |
| --- | --- |
| Windows | `%LOCALAPPDATA%/BrowserPilot/config.json` |
| macOS | `~/Library/Application Support/BrowserPilot/config.json` |
| Linux | `$XDG_DATA_HOME/browserpilot/config.json`, or `~/.local/share/browserpilot/config.json` |

`BROWSERPILOT_CONFIG_PATH` overrides the config file. `BROWSERPILOT_DATA_DIR`
overrides the state directory. `BROWSERPILOT_COMPANION_PORT`,
`BROWSERPILOT_COMPANION_TOKEN`, `BROWSERPILOT_BROWSER_BACKEND`,
`BROWSERPILOT_PROFILE_DIR`, `BROWSERPILOT_DOWNLOAD_DIR`, `BROWSERPILOT_UPLOAD_DIR`,
`BROWSERPILOT_HEADLESS` and `BROWSERPILOT_CHROME_PATH` override individual values.
Tokens and pairing JSON belong only on the local machine.

The default companion is `http://127.0.0.1:8765`. Extension downloads go to
`~/Downloads/BrowserPilot`; Playwright downloads use the data directory. If you
changed your browser's default download directory, set the companion download
directory to that directory plus `BrowserPilot`. Root directories must be dedicated
to BrowserPilot; do not point the upload/download store at your home directory.

`start` runs a foreground companion for clients that share it. `mcp` reuses a
healthy matching companion or starts one, and stops only a child it owns on client
disconnect. It will reject a different service or a mismatched local token on
the configured port instead of taking over that service.
