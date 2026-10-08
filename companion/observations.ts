import { randomBytes } from "node:crypto";

type Observation = {
  observationId: string;
  profileId: string;
  pageId: string;
  url: string;
  operation: string;
  observedAt: string;
};

// Metadata only: never retain page text, screenshots, URL queries, or credentials.
export class ObservationHistory {
  private entries: Array<Observation & { expiresAt: number }> = [];

  constructor(private readonly now = Date.now) {}

  record(profileId: string, pageId: string, rawUrl: string, operation: string): void {
    this.prune();
    let url: URL;
    try { url = new URL(rawUrl); } catch { return; }
    if (!/^https?:$/.test(url.protocol)) return;
    const redacted = `${url.origin}${url.pathname}`.slice(0, 512);
    this.entries = this.entries.filter((entry) => !(entry.profileId === profileId && entry.pageId === pageId && entry.url === redacted));
    this.entries.push({ observationId: randomBytes(16).toString("hex"), profileId, pageId, url: redacted,
      operation, observedAt: new Date(this.now()).toISOString(), expiresAt: this.now() + 10 * 60_000 });
    this.entries = this.entries.slice(-64);
  }

  recent(profileId: string): Observation[] {
    this.prune();
    return this.entries.filter((entry) => entry.profileId === profileId).slice(-8)
      .map(({ expiresAt: _expiresAt, ...entry }) => ({ ...entry }));
  }

  private prune(): void {
    this.entries = this.entries.filter((entry) => entry.expiresAt > this.now());
  }
}
