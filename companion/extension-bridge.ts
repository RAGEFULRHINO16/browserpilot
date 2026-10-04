import { timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { localRequestAllowed } from "./local-http";

const profilePattern = /^[a-z][a-z0-9-]{0,31}$/;
const extensionOrigin = /^chrome-extension:\/\/[a-p]{32}$/;

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout };
type Peer = { socket: WebSocket; pending: Map<number, Pending>; extensionId: string };

export class ExtensionBridge {
  private readonly peers = new Map<string, Peer>();
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  private nextId = 1;
  activeId = "default";

  constructor(private readonly token: string, private readonly port = 8765) {}

  attach(server: Server): void {
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
        if (old) old.socket.close(1001, "Replaced by new connection");
        this.peers.set(profileId, { socket, pending: new Map(), extensionId });
        socket.send(JSON.stringify({ type: "ready", profileId }));
        return;
      }
      const peer = this.peers.get(profileId);
      if (!peer || peer.socket !== socket || typeof message.id !== "number" || !Number.isSafeInteger(message.id)) return;
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
      this.peers.delete(profileId);
      for (const pending of peer.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Brave extension disconnected. Reopen Brave and try again."));
      }
    });
    socket.on("error", () => socket.close(1011, "Bridge error"));
  }

  profiles(): Array<{ id: string; active: boolean; connected: boolean }> {
    return [...this.peers.keys()].map((id) => ({ id, active: id === this.activeId, connected: true }));
  }

  select(id: string): void {
    if (!profilePattern.test(id)) throw new Error("Invalid profile ID.");
    if (!this.peers.has(id)) throw new Error(`Brave profile '${id}' is not connected. Install and pair the BrowserPilot extension in that profile.`);
    this.activeId = id;
  }

  connected(id = this.activeId): boolean {
    return this.peers.has(id);
  }

  rpc<T>(command: string, args: unknown = {}, profileId = this.activeId, timeoutMs = 30_000): Promise<T> {
    const peer = this.peers.get(profileId);
    if (!peer || peer.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Brave extension is not connected. Keep daily Brave open and load BrowserPilot from brave://extensions."));
    }
    if (peer.pending.size >= 32) return Promise.reject(new Error("Extension command queue is full. Retry later."));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        peer.pending.delete(id);
        reject(new Error(`Brave extension timed out during ${command}.`));
      }, timeoutMs);
      peer.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      peer.socket.send(JSON.stringify({ id, command, args }), (error) => {
        if (!error) return;
        clearTimeout(timer);
        peer.pending.delete(id);
        reject(error);
      });
    });
  }
}
