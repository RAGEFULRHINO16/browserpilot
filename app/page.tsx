export default function HomePage() {
  return (
    <main style={{ fontFamily: "Georgia, serif", maxWidth: 680, margin: "10vh auto", padding: 24 }}>
      <h1>BrowserPilot</h1>
      <p>Local browser control for agents that speak MCP. Connect through stdio, or this authenticated loopback HTTP endpoint at <code>/mcp</code>.</p>
      <p>Pair the browser extension, approve the websites you want to use, and review actions on your local approval page.</p>
      <p><a href="https://github.com/RAGEFULRHINO16/browserpilot">Source, installation and security boundaries</a></p>
    </main>
  );
}
