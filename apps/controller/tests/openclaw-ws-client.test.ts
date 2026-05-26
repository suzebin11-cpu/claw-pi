import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { ControllerEnv } from "../src/app/env.js";
import { OpenClawWsClient } from "../src/runtime/openclaw-ws-client.js";

type CloseRecord = {
  code?: number;
  reason?: string;
};

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];
  closed: CloseRecord | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    this.closed = { code, reason };
    this.readyState = FakeWebSocket.CLOSED;
    setTimeout(() => {
      this.onclose?.({ code, reason });
    }, 0);
  }

  emitMessage(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

describe("OpenClawWsClient", () => {
  let rootDir: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-openclaw-ws-"));
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    await rm(rootDir, { recursive: true, force: true });
  });

  function createClient(): OpenClawWsClient {
    return new OpenClawWsClient({
      openclawGatewayPort: 18789,
      openclawGatewayToken: "test-token",
      openclawStateDir: rootDir,
    } as ControllerEnv);
  }

  it("reconnects if the gateway accepts a socket but never sends a challenge", async () => {
    const client = createClient();

    client.connect();

    expect(FakeWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15_001);
    expect(FakeWebSocket.instances[0]?.closed?.reason).toBe(
      "connect challenge timeout",
    );

    await vi.advanceTimersByTimeAsync(500);
    expect(FakeWebSocket.instances).toHaveLength(2);

    client.stop();
  });

  it("reconnects quickly if the connect request does not receive a response", async () => {
    const client = createClient();

    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket?.emitMessage({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "nonce-1" },
    });

    expect(socket?.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15_001);
    expect(socket?.closed?.reason).toBe("connect timeout");

    await vi.advanceTimersByTimeAsync(500);
    expect(FakeWebSocket.instances).toHaveLength(2);

    client.stop();
  });

  it("does not reconnect when the handshake succeeds", async () => {
    const client = createClient();

    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket?.emitMessage({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "nonce-1" },
    });
    const connectRequest = JSON.parse(socket?.sent[0] ?? "{}") as {
      id?: string;
    };
    socket?.emitMessage({
      type: "res",
      id: connectRequest.id,
      ok: true,
      payload: {
        policy: { tickIntervalMs: 30_000 },
      },
    });

    expect(client.isConnected()).toBe(true);
    await vi.advanceTimersByTimeAsync(15_001);
    expect(socket?.closed).toBeNull();
    expect(FakeWebSocket.instances).toHaveLength(1);

    client.stop();
  });
});
