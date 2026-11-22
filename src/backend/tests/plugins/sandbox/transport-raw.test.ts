/**
 * Fork: ctx.ssh.openTransport with raw, for a stream that is not SSH.
 *
 * Direct RDP reaches a host's RDP port by the route the host is configured
 * to use -- a jump host, a VPN, the host's own proxy -- and it does that
 * through core, since core is what knows the route. In a plugin process core
 * holds every byte until the far end greets as an SSH server. An RDP server
 * never does, so without raw the session hung on a socket that was open.
 *
 * Raw is only for a plugin holding network:sockets, which can already dial
 * anything itself; one without it still gets the greeting check.
 */
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

const granted = vi.hoisted(() => ({ sockets: true }));
vi.mock("../../../plugins/permissions.js", () => ({
  hasCapability: async (_id: string, capability: string) =>
    capability === "network:sockets" ? granted.sockets : true,
}));

import { PluginBridge } from "../../../plugins/sandbox/bridge.js";
import {
  Endpoint,
  type StreamPort,
  type Transport,
  type Wire,
} from "../../../plugins/sandbox/rpc.js";
import { SandboxTokenStore } from "../../../plugins/sandbox/tokens.js";

function setup() {
  const hostHandlers: Array<(m: Wire) => void> = [];
  const childHandlers: Array<(m: Wire) => void> = [];
  const hostTransport: Transport = {
    send: (m) => {
      const copy = structuredClone(m);
      setImmediate(() => childHandlers.forEach((h) => h(copy)));
    },
    onMessage: (h) => hostHandlers.push(h),
  };
  const childTransport: Transport = {
    send: (m) => {
      const copy = structuredClone(m);
      setImmediate(() => hostHandlers.forEach((h) => h(copy)));
    },
    onMessage: (h) => childHandlers.push(h),
  };
  const openTransport = vi.fn(async () => ({
    jumpClient: null,
    via: "direct",
  }));
  const ctx = {
    pluginId: "rdp-direct",
    log: { info: () => {}, error: () => {} },
    ssh: { openTransport },
  };
  new PluginBridge(hostTransport, {
    manifest: {
      id: "rdp-direct",
      capabilities: ["network:sockets"],
      sandbox: {},
    } as never,
    ctx: ctx as never,
    tokens: new SandboxTokenStore(),
    dialect: "sqlite",
  });
  const child = new Endpoint(childTransport, {
    side: "c",
    outboundToken: () => undefined,
    inbound: (_token, run) => run(),
  });
  return { child, openTransport };
}

const servers: net.Server[] = [];
afterEach(() => {
  granted.sockets = true;
  for (const s of servers.splice(0)) s.close();
});

/** A server that speaks first only when spoken to, like RDP. */
async function rdpLike(received: Buffer[]): Promise<number> {
  const s = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      received.push(chunk);
      socket.write("X224-CC");
    });
  });
  servers.push(s);
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  return (s.address() as net.AddressInfo).port;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await wait(10);
  }
};

describe("ssh.openTransport with raw", () => {
  it("carries bytes both ways to a server that never greets", async () => {
    const received: Buffer[] = [];
    const port = await rdpLike(received);
    const { child } = setup();
    const result = (await child.call("ssh.openTransport", [
      1,
      { host: "127.0.0.1", port },
      { raw: true },
    ])) as { sock: StreamPort };

    const got: Buffer[] = [];
    result.sock.on("data", (chunk: Buffer) => got.push(chunk));
    result.sock.write(Buffer.from("X224-CR"));

    await until(() => got.length > 0);
    expect(Buffer.concat(received).toString()).toBe("X224-CR");
    expect(Buffer.concat(got).toString()).toBe("X224-CC");
  });

  it("is refused without network:sockets", async () => {
    granted.sockets = false;
    const { child, openTransport } = setup();
    await expect(
      child.call("ssh.openTransport", [
        1,
        { host: "127.0.0.1", port: 3389 },
        { raw: true },
      ]),
    ).rejects.toThrow(/needs network:sockets/);
    // Refused before any route was opened.
    expect(openTransport).not.toHaveBeenCalled();
  });

  it("does not change a stream that did not ask", async () => {
    const received: Buffer[] = [];
    const port = await rdpLike(received);
    const { child } = setup();
    const result = (await child.call("ssh.openTransport", [
      1,
      { host: "127.0.0.1", port },
      {},
    ])) as { sock: StreamPort };
    result.sock.on("error", () => {});
    result.sock.write(Buffer.from("X224-CR"));
    await wait(150);
    // Still held for a greeting that this server will never send.
    expect(received).toHaveLength(0);
  });
});
