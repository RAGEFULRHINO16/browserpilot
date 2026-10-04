import type { ReactNode } from "react";

export const metadata = {
  title: "BrowserPilot",
  description: "Local browser control for agents that speak MCP",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
