import { timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { localRequestAllowed } from "./local-http";

const profilePattern = /^[a-z][a-z0-9-]{0,31}$/;
const extensionOrigin = /^chrome-extension:\/\/[a-p]{32}$/;

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout };
type Peer = { socket: WebSocket; pending: Map<number, Pending>; extensionId: string; alive: boolean };
const uncertainOutcome = "Inspect the page before retrying; the action may have completed.";

export class ExtensionBridge {
  private readonly peers = new Map<string, Peer>();
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  private nextId = 1;
  activeId = "default";

  constructor(private readonly token: string, private readonly port = 8765,
    private readonly options: { heartbeatIntervalMs?: number } = {}) {}

  attach(server: Server): void {
    const intervalMs = this.options.heartbeatIntervalMs ?? 15_000;
    if (!Number.isInteger(intervalMs) || intervalMs < 5 || intervalMs > 60_000) throw new Error("Invalid bridge heartbeat interval.");
    const heartbeat = setInterval(() => {
      for (const [profileId, peer] of this.peers) {
        if (!peer.alive || peer.socket.readyState !== WebSocket.OPEN) {
          this.removePeer(profileId, peer, `Browser extension connection became unresponsive. ${uncertainOutcome}`);
          peer.socket.terminate();
          continue;
        }
        peer.alive = false;
        peer.socket.ping((error?: Error) => {
          if (!error) return;
          this.removePeer(profileId, peer, `Browser extension heartbeat failed. ${uncertainOutcome}`);
          peer.socket.terminate();
        });
      }
    }, intervalMs);
    heartbeat.unref();
    server.once("close", () => {
      clearInterval(heartbeat);
      for (const [profileId, peer] of this.peers) {
        this.removePeer(profileId, peer, `BrowserPilot companion stopped. ${uncertainOutcome}`);
        peer.socket.terminate();
      }
      this.server.close();
    });
    server.on("upgrade", (request, socket, head) => {
      if (request.url !== "/bridge" || !extensionOrigin.test(request.headers.origin || "") ||
          !localRequestAllowed(request, this.port, { extensionOrigin: true }) || this.server.clients.size >= 16) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      this.server.handleUpgrade(request, socket, head, (webSocket) => {
        this.accept(webSocket, request.headers.origin!.slice("chrome-extension://".length));
      });
    });
  }

  private accept(socket: WebSocket, extensionId: string): void {
    let profileId: string | undefined;
    const authTimer = setTimeout(() => socket.close(1008, "Authentication timeout"), 5_000);
    socket.on("message", (raw) => {
      let message: Record<string, unknown>;
      try { message = JSON.parse(raw.toString()) as Record<string, unknown>; }
      catch { socket.close(1008, "Invalid JSON"); return; }
      if (!message || Array.isArray(message) || typeof message !== "object") { socket.close(1008, "Invalid message"); return; }
      if (!profileId) {
        const supplied = Buffer.from(typeof message.token === "string" ? message.token : "");
        const expected = Buffer.from(this.token);
        if (message.type !== "hello" || !profilePattern.test(String(message.profileId || "")) ||
            supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
          socket.close(1008, "Invalid bridge credentials");
          return;
        }
        clearTimeout(authTimer);
        profileId = String(message.profileId);
        const old = this.peers.get(profileId);
        if (old) {
          this.removePeer(profileId, old, `Browser extension reconnected during this request. ${uncertainOutcome}`);
          old.socket.close(1001, "Replaced by new connection");
        }
        this.peers.set(profileId, { socket, pending: new Map(), extensionId, alive: true });
        socket.send(JSON.stringify({ type: "ready", profileId }));
        return;
      }
      const peer = this.peers.get(profileId);
      if (!peer || peer.socket !== socket) return;
      peer.alive = true;
      if (typeof message.id !== "number" || !Number.isSafeInteger(message.id)) return;
      const pending = peer.pending.get(message.id);
      if (!pending) return;
      peer.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (typeof message.error === "string") pending.reject(new Error(message.error.slice(0, 500)));
      else pending.resolve(message.result);
    });
    socket.on("close", () => {
      clearTimeout(authTimer);
      if (!profileId) return;
      const peer = this.peers.get(profileId);
      if (!peer || peer.socket !== socket) return;
      this.removePeer(profileId, peer, `Browser extension disconnected. ${uncertainOutcome}`);
    });
    socket.on("pong", () => {
      const peer = profileId ? this.peers.get(profileId) : undefined;
      if (peer?.socket === socket) peer.alive = true;
    });
    socket.on("error", () => socket.close(1011, "Bridge error"));
  }

  private removePeer(profileId: string, peer: Peer, message: string): void {
    if (this.peers.get(profileId) === peer) this.peers.delete(profileId);
    for (const pending of peer.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    peer.pending.clear();
  }

  profiles(): Array<{ id: string; active: boolean; connected: boolean }> {
    return [...this.peers].filter(([, peer]) => peer.socket.readyState === WebSocket.OPEN)
      .map(([id]) => ({ id, active: id === this.activeId, connected: true }));
  }

  select(id: string): void {
    if (!profilePattern.test(id)) throw new Error("Invalid profile ID.");
    if (!this.connected(id)) throw new Error(`Browser profile '${id}' is not connected. Install and pair the BrowserPilot extension in that profile.`);
    this.activeId = id;
  }

  connected(id = this.activeId): boolean {
    return this.peers.get(id)?.socket.readyState === WebSocket.OPEN;
  }

  rpc<T>(command: string, args: unknown = {}, profileId = this.activeId, timeoutMs = 30_000): Promise<T> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) return Promise.reject(new Error("Invalid extension command timeout."));
    const peer = this.peers.get(profileId);
    if (!peer || peer.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Brave extension is not connected. Keep daily Brave open and load BrowserPilot from brave://extensions."));
    }
    if (peer.pending.size >= 32) return Promise.reject(new Error("Extension command queue is full. Retry later."));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        peer.pending.delete(id);
        reject(new Error(`Browser extension timed out during ${command}. ${uncertainOutcome}`));
      }, timeoutMs);
      peer.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      peer.socket.send(JSON.stringify({ id, command, args, deadlineAt: Date.now() + timeoutMs }), (error) => {
        if (!error) return;
        clearTimeout(timer);
        peer.pending.delete(id);
        reject(error);
      });
    });
  }
}
