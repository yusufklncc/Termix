import crypto from "crypto";
import net from "net";
import { describe, expect, it } from "vitest";
import {
  managedDoorPort,
  resolveInManagedNetwork,
  resolveNetManagerOptions,
  sealCredentials,
} from "../../utils/net-manager-client.js";

/**
 * The manager unseals with its own copy of this derivation (docker/net-manager
 * /manager.js). Nothing links the two but agreement, so this is where that
 * agreement is written down: change one side and this fails rather than a
 * network quietly refusing to come up.
 */
function unsealTheWayTheManagerDoes(
  token: string,
  sealed: { iv: string; tag: string; data: string },
) {
  const key = Buffer.from(
    crypto.hkdfSync(
      "sha256",
      Buffer.from(token, "utf8"),
      Buffer.from("termix-net-manager", "utf8"),
      Buffer.from("credentials", "utf8"),
      32,
    ),
  );
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(sealed.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(sealed.data, "base64")),
      decipher.final(),
    ]).toString("utf8"),
  );
}

describe("sealCredentials", () => {
  it("is opened by the derivation the manager uses", () => {
    const sealed = sealCredentials("a-long-secret", {
      username: "u",
      password: "p",
    });
    expect(unsealTheWayTheManagerDoes("a-long-secret", sealed)).toEqual({
      username: "u",
      password: "p",
    });
  });

  it("does not carry the secret in the clear", () => {
    const sealed = sealCredentials("a-long-secret", { password: "hunter2" });
    expect(JSON.stringify(sealed)).not.toContain("hunter2");
  });

  it("is not opened under a different secret", () => {
    const sealed = sealCredentials("a-long-secret", { password: "hunter2" });
    expect(() =>
      unsealTheWayTheManagerDoes("another-secret", sealed),
    ).toThrow();
  });

  it("uses a fresh nonce each time", () => {
    const first = sealCredentials("s", { password: "p" });
    const second = sealCredentials("s", { password: "p" });
    expect(first.iv).not.toEqual(second.iv);
    expect(first.data).not.toEqual(second.data);
  });
});

describe("managedDoorPort", () => {
  it("is computed from the id, so a restart need not be announced", () => {
    expect(managedDoorPort(7)).toBe(20007);
  });
});

describe("resolveNetManagerOptions", () => {
  it("is absent without a secret, so managed networks fail rather than guess", () => {
    const saved = process.env.NET_MANAGER_TOKEN;
    delete process.env.NET_MANAGER_TOKEN;
    expect(resolveNetManagerOptions()).toBeNull();
    if (saved !== undefined) process.env.NET_MANAGER_TOKEN = saved;
  });

  it("takes a host:port, and falls back to the sidecar's own name", () => {
    process.env.NET_MANAGER_TOKEN = "s";
    process.env.NET_MANAGER_URL = "netmgr.internal:4000";
    expect(resolveNetManagerOptions()).toMatchObject({
      host: "netmgr.internal",
      port: 4000,
    });
    delete process.env.NET_MANAGER_URL;
    expect(resolveNetManagerOptions()).toMatchObject({
      host: "termix-netmgr",
      port: 3392,
    });
    delete process.env.NET_MANAGER_TOKEN;
  });
});

/**
 * A name only the network knows.
 *
 * Asking is the whole point, but an answer that never comes must not stop the
 * connection: without one the name travels to the gateway exactly as it did
 * before any of this existed, and the far side says what it makes of it.
 */
describe("resolving a name inside a managed network", () => {
  /** Speaks the manager's framing: 4-byte magic, u32LE length, JSON. */
  function fakeManager(reply: (body: Record<string, unknown>) => unknown) {
    const server = net.createServer((socket) => {
      const chunks: Buffer[] = [];
      socket.on("data", (chunk) => {
        chunks.push(chunk);
        const buffer = Buffer.concat(chunks);
        if (buffer.length < 8) return;
        const length = buffer.readUInt32LE(4);
        if (buffer.length < 8 + length) return;
        const body = JSON.parse(buffer.subarray(8, 8 + length).toString());
        const payload = Buffer.from(JSON.stringify(reply(body)));
        const header = Buffer.alloc(8);
        header.write("NRES".padEnd(4, " "), 0, 4, "ascii");
        header.writeUInt32LE(payload.length, 4);
        socket.end(Buffer.concat([header, payload]));
      });
    });
    return server;
  }

  async function withManager(
    reply: (body: Record<string, unknown>) => unknown,
    run: (options: {
      host: string;
      port: number;
      token: string;
    }) => Promise<void>,
  ) {
    const server = fakeManager(reply);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as net.AddressInfo;
    try {
      await run({ host: "127.0.0.1", port, token: "secret" });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  it("gives back the address the network reports", async () => {
    await withManager(
      () => ({ ok: true, address: "100.92.0.5" }),
      async (options) => {
        await expect(
          resolveInManagedNetwork(4, "kayizer-vds", options),
        ).resolves.toBe("100.92.0.5");
      },
    );
  });

  it("answers nothing when the network keeps no list", async () => {
    await withManager(
      () => ({ ok: true, address: null }),
      async (options) => {
        await expect(
          resolveInManagedNetwork(4, "some-host", options),
        ).resolves.toBeNull();
      },
    );
  });

  it("answers nothing when the manager refuses", async () => {
    await withManager(
      () => ({ ok: false, error: "this VPN is not registered" }),
      async (options) => {
        await expect(
          resolveInManagedNetwork(99, "some-host", options),
        ).resolves.toBeNull();
      },
    );
  });

  it("answers nothing when there is no manager to ask", async () => {
    await expect(
      resolveInManagedNetwork(4, "some-host", {
        host: "127.0.0.1",
        port: 1,
        token: "secret",
      }),
    ).resolves.toBeNull();
  });
});
