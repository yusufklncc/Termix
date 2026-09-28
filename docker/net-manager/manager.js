import net from "node:net";
import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";

/*
 * Termix's network manager.
 *
 * Termix asks for a network to be up; this puts it in a namespace of its own
 * and answers with the address traffic for it should be handed to. Everything
 * downstream of that address -- the resolver, the tunnels, the refusal when
 * the doorway is gone -- is phase 8's and unchanged.
 */

const TOKEN = process.env.NET_MANAGER_TOKEN ?? "";
const PORT = Number(process.env.NET_MANAGER_PORT ?? 3392);
const BIND = process.env.NET_MANAGER_BIND ?? "0.0.0.0";
/** Doorways start here; a profile's is this plus its id, as Termix computes. */
const DOOR_BASE = Number(process.env.NET_MANAGER_DOOR_BASE ?? 20000);
const SUBNET_PREFIX = process.env.NET_MANAGER_SUBNET ?? "10.88";

if (!TOKEN) {
  // A control channel that carries passwords and takes anyone's word for who
  // is speaking is worse than one that does not start.
  console.error("[net-manager] NET_MANAGER_TOKEN is required");
  process.exit(1);
}

const log = (...parts) => console.log("[net-manager]", ...parts);
const logError = (...parts) => console.error("[net-manager]", ...parts);

// ---------------------------------------------------------------- framing

/** Wire frame: 4-byte ASCII magic, u32 little-endian length, payload. The
 * same shape the RDP bridge speaks, for the same reason: it is already here. */
function encodeFrame(magic, payload) {
  const header = Buffer.alloc(8);
  header.write(magic.padEnd(4, " "), 0, 4, "ascii");
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function createFrameReader(onFrame) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 8) return;
      const length = buffer.readUInt32LE(4);
      if (buffer.length < 8 + length) return;
      const magic = buffer.subarray(0, 4).toString("ascii");
      const payload = buffer.subarray(8, 8 + length);
      buffer = buffer.subarray(8 + length);
      onFrame(magic, payload);
    }
  };
}

// ------------------------------------------------------------- sealing

/*
 * The token is not only proof of who is speaking; it is also the key the
 * credentials travel under. A Docker bridge network keeps containers apart,
 * but one with NET_RAW on the same network can listen, and a VPN password is
 * not something to hand it. Deriving from the token costs nothing next to
 * managing certificates for a channel with exactly one client.
 */
const sealKey = crypto.hkdfSync(
  "sha256",
  Buffer.from(TOKEN, "utf8"),
  Buffer.from("termix-net-manager", "utf8"),
  Buffer.from("credentials", "utf8"),
  32,
);

function unseal(sealed) {
  const iv = Buffer.from(sealed.iv, "base64");
  const tag = Buffer.from(sealed.tag, "base64");
  const data = Buffer.from(sealed.data, "base64");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    Buffer.from(sealKey),
    iv,
  );
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(plain.toString("utf8"));
}

// ------------------------------------------------------------- namespaces

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.message = `${command} ${args.join(" ")}: ${stderr || error.message}`;
        reject(error);
      } else resolve(stdout);
    });
  });
}

/** Best-effort: used when tearing down, where a missing thing is the goal. */
const tryRun = (command, args) => run(command, args).catch(() => {});

const nsName = (id) => `tx${id}`;

/**
 * Entering a namespace without asking for /sys.
 *
 * `ip netns exec` remounts /sys so that /sys/class/net shows the namespace's
 * interfaces. Nothing here reads that, and the remount is refused on hosts
 * that do not allow nested sysfs mounts -- LXC among them -- where it fails
 * with "mount of /sys failed" and takes the whole network with it. nsenter
 * changes the network namespace and nothing else.
 */
const inNamespace = (id, command, args) => [
  "nsenter",
  [`--net=/var/run/netns/${nsName(id)}`, command, ...args],
];

/**
 * A /30 per profile out of one /16. The namespace side is .2 and this side
 * .1, so both are computable from the id and nothing has to be remembered
 * across a restart.
 */
function addresses(id) {
  const base = id * 4;
  if (base + 3 > 65535) throw new Error(`profile id ${id} is out of range`);
  const octet3 = base >> 8;
  const octet4 = base & 255;
  const network = `${SUBNET_PREFIX}.${octet3}.${octet4}`;
  return {
    host: `${SUBNET_PREFIX}.${octet3}.${octet4 + 1}`,
    peer: `${SUBNET_PREFIX}.${octet3}.${octet4 + 2}`,
    network,
  };
}

async function uplinkInterface() {
  const routes = await run("ip", ["-o", "route", "show", "default"]);
  const match = routes.match(/\sdev\s+(\S+)/);
  if (!match) throw new Error("no default route to leave by");
  return match[1];
}

let forwardingReady = false;
async function ensureForwarding() {
  if (forwardingReady) return;
  // Checked, not set: /proc/sys is read-only in a container, and the value is
  // the operator's to give at start. It is on by default, so this is here for
  // the deployment where it is not, to say so rather than to fail later as a
  // network that quietly reaches nothing.
  const { promises: fs } = await import("node:fs");
  const forwarding = (
    await fs.readFile("/proc/sys/net/ipv4/ip_forward", "utf8")
  ).trim();
  if (forwarding !== "1") {
    throw new Error(
      "IPv4 forwarding is off, so a network namespace cannot reach its " +
        "gateway. Add `sysctls: [net.ipv4.ip_forward=1]` to this service.",
    );
  }
  const uplink = await uplinkInterface();
  // The namespaces reach the VPN gateway through this container's own route.
  // Only that: what happens after the tunnel is up is the namespace's own
  // business, and its rules say the rest.
  await run("iptables", [
    "-t",
    "nat",
    "-C",
    "POSTROUTING",
    "-s",
    `${SUBNET_PREFIX}.0.0/16`,
    "-o",
    uplink,
    "-j",
    "MASQUERADE",
  ]).catch(() =>
    run("iptables", [
      "-t",
      "nat",
      "-A",
      "POSTROUTING",
      "-s",
      `${SUBNET_PREFIX}.0.0/16`,
      "-o",
      uplink,
      "-j",
      "MASQUERADE",
    ]),
  );
  forwardingReady = true;
}

async function createNamespace(id) {
  const ns = nsName(id);
  const { host, peer } = addresses(id);
  const vethHost = `${ns}a`;
  const vethPeer = `${ns}b`;

  await tryRun("ip", ["netns", "del", ns]);
  await tryRun("ip", ["link", "del", vethHost]);

  await run("ip", ["netns", "add", ns]);
  await run("ip", [
    "link",
    "add",
    vethHost,
    "type",
    "veth",
    "peer",
    "name",
    vethPeer,
  ]);
  await run("ip", ["link", "set", vethPeer, "netns", ns]);
  await run("ip", ["addr", "add", `${host}/30`, "dev", vethHost]);
  await run("ip", ["link", "set", vethHost, "up"]);
  await run(
    ...inNamespace(id, "ip", ["addr", "add", `${peer}/30`, "dev", vethPeer]),
  );
  await run(...inNamespace(id, "ip", ["link", "set", vethPeer, "up"]));
  await run(...inNamespace(id, "ip", ["link", "set", "lo", "up"]));
  await run(...inNamespace(id, "ip", ["route", "add", "default", "via", host]));

  return { ns, host, peer, vethHost };
}

async function destroyNamespace(id) {
  const ns = nsName(id);
  await tryRun("ip", ["netns", "del", ns]);
  await tryRun("ip", ["link", "del", `${ns}a`]);
}

/**
 * Anything the tunnel does not carry is refused, inside every namespace
 * separately -- the same rule phase 8's sidecar applies, for the same reason:
 * a split-routed VPN otherwise lets an address outside its routes leave by
 * this container's own way out, quietly.
 */
async function applyStrictRoutes(id, iface, gatewayIps) {
  const rule = (args) => run(...inNamespace(id, "iptables", args));
  await rule(["-N", "TERMIX_OUT"]);
  await rule(["-A", "TERMIX_OUT", "-o", "lo", "-j", "ACCEPT"]);
  await rule(["-A", "TERMIX_OUT", "-o", iface, "-j", "ACCEPT"]);
  await rule([
    "-A",
    "TERMIX_OUT",
    "-m",
    "conntrack",
    "--ctstate",
    "ESTABLISHED,RELATED",
    "-j",
    "ACCEPT",
  ]);
  for (const ip of gatewayIps) {
    await rule(["-A", "TERMIX_OUT", "-d", ip, "-j", "ACCEPT"]);
  }
  await rule([
    "-A",
    "TERMIX_OUT",
    "-j",
    "REJECT",
    "--reject-with",
    "icmp-port-unreachable",
  ]);
  await rule(["-A", "OUTPUT", "-j", "TERMIX_OUT"]);
}

// ------------------------------------------------------------- providers

async function resolveGatewayIps(host) {
  const { promises: dns } = await import("node:dns");
  const records = await dns.lookup(host, { all: true, family: 4 });
  return records.map((record) => record.address);
}

/**
 * One provider for now, deliberately: Fortinet over openconnect, because it
 * is the only gateway this can be measured against. The shape a second one
 * has to fit is visible from here -- a command, an interface name, and what
 * it needs on stdin.
 */
function buildProviderCommand(profile, credentials, gatewayIps) {
  if (profile.provider !== "fortinet") {
    throw new Error(`unsupported provider: ${profile.provider}`);
  }
  const host = profile.serverHost;
  const args = [
    "--protocol=fortinet",
    "--user",
    credentials.username,
    "--passwd-on-stdin",
    "--interface",
    "tun0",
    "--non-inter",
    // The namespace has no resolver of its own, and the name is kept because
    // the certificate is issued to it -- so the address is handed over
    // instead, having been looked up out here where resolution works.
    ...gatewayIps.flatMap((ip) => ["--resolve", `${host}:${ip}`]),
    // Routes from the tunnel, but not its DNS; see the script for why.
    "--script",
    "/app/vpnc-script-no-dns",
  ];
  if (profile.trustedFingerprint) {
    args.push(
      "--servercert",
      `pin-sha256:${String(profile.trustedFingerprint).replace(/^pin-sha256:/, "")}`,
    );
  }
  args.push(`https://${host}:${profile.serverPort ?? 443}`);
  return {
    command: "openconnect",
    args,
    iface: "tun0",
    stdin: `${credentials.password}\n`,
  };
}

/*
 * A refusal is not a failure to retry.
 *
 * A dropped tunnel is worth raising again; a password the gateway refused is
 * not. Trying it again cannot succeed, and a FortiGate counts the attempts --
 * which is how an account gets locked, and then stays locked, because the
 * next attempt arrives before the lockout lapses. With a doorway that raises
 * on demand this matters twice over: without it, every connection would be
 * another attempt.
 */
function looksRefused(reason) {
  return /authentication (failed|error)|failed to complete authentication|login failed|permission denied|user input required|invalid credential/i.test(
    String(reason ?? ""),
  );
}

/** The last thing the client said, which is usually the reason. */
function lastWords(said) {
  const interesting = (said ?? []).filter(
    (line) =>
      line.trim() && !line.startsWith("POST ") && !line.startsWith("GET "),
  );
  return interesting.slice(-2).join("; ");
}

function waitForInterface(id, iface, vpnProcess, timeoutMs = 60000, said) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (vpnProcess.exitCode !== null) {
        const reason = lastWords(said);
        return reject(
          new Error(
            reason
              ? `the VPN client stopped: ${reason}`
              : "the VPN client exited before the tunnel came up",
          ),
        );
      }
      try {
        await run(...inNamespace(id, "ip", ["link", "show", iface]));
        return resolve();
      } catch {
        if (Date.now() > deadline) {
          return reject(new Error("the tunnel did not come up in time"));
        }
        setTimeout(tick, 1000);
      }
    };
    tick();
  });
}

// ------------------------------------------------------------- lifecycle

/**
 * id -> {
 *   profile, credentials,   what it takes to raise this one again
 *   doorway, port,          always listening while the VPN is registered
 *   live,                   open connections through the doorway
 *   tunnel,                 { procs, ns } while it is up, else null
 *   raising,                a promise, so ten connections raise it once
 *   refused, error,         a password the gateway rejected is not retried
 *   idleTimer,
 * }
 */
const networks = new Map();

/**
 * How long a VPN stays up with nothing going through it.
 *
 * Not zero: opening and closing tabs in a row would otherwise raise and drop
 * the tunnel each time, which is slow and is a login attempt at the gateway
 * every time.
 */
const IDLE_MS = Number(process.env.NET_MANAGER_IDLE_MS ?? 300000);

function stateOf(entry) {
  if (!entry) return "unknown";
  if (entry.refused) return "refused";
  if (entry.tunnel) return "up";
  if (entry.raising) return "connecting";
  return "idle";
}

async function raiseTunnel(id) {
  const entry = networks.get(id);
  if (!entry) throw new Error("this VPN is not registered");
  if (entry.tunnel) return;
  if (entry.raising) return entry.raising;

  /*
   * A password the gateway refused is not tried again on the next
   * connection.
   *
   * Every attempt counts at a FortiGate, and a doorway that raises on demand
   * would turn one wrong password into an attempt per connection -- which
   * locks the account and then keeps it locked. Editing the profile clears
   * this, because editing is the only thing that can change the answer.
   */
  if (entry.refused) {
    throw new Error(entry.error ?? "the gateway refused these credentials");
  }

  entry.raising = (async () => {
    const { profile, credentials } = entry;
    await ensureForwarding();
    const { peer } = await createNamespace(id);

    const gatewayIps = await resolveGatewayIps(profile.serverHost);
    const { command, args, iface, stdin } = buildProviderCommand(
      profile,
      credentials,
      gatewayIps,
    );

    /*
     * The client's own words are kept, because they are the answer. "The VPN
     * client exited" tells an operator nothing; "authentication failed" tells
     * them what to change.
     */
    const said = [];
    const remember = (chunk) => {
      process.stderr.write(chunk);
      for (const line of chunk.toString().split("\n")) {
        const text = line.trim();
        if (text) said.push(text);
      }
      if (said.length > 40) said.splice(0, said.length - 40);
    };

    const procs = [];
    try {
      const vpn = spawn(...inNamespace(id, command, args), {
        stdio: ["pipe", "pipe", "pipe"],
      });
      vpn.stdout.on("data", remember);
      vpn.stderr.on("data", remember);
      procs.push(vpn);
      vpn.stdin.end(stdin);
      vpn.on("exit", (code) => {
        const current = networks.get(id);
        if (!current || current.tunnel?.procs[0] !== vpn) return;
        log(`VPN ${id}: tunnel ended (${code})`);
        // Whatever is going through it now has nowhere to go, which is the
        // point: it must not leave by this container's own route instead.
        void dropTunnel(id);
      });

      await waitForInterface(id, iface, vpn, 60000, said);
      await applyStrictRoutes(id, iface, gatewayIps);

      const socks = spawn(
        ...inNamespace(id, "microsocks", ["-i", peer, "-p", "1080"]),
        { stdio: ["ignore", "inherit", "inherit"] },
      );
      procs.push(socks);

      entry.tunnel = { procs, ns: nsName(id) };
      entry.error = null;
      log(`VPN ${id} is up`);
    } catch (error) {
      for (const proc of procs) {
        try {
          proc.kill("SIGTERM");
        } catch {
          /* already gone */
        }
      }
      await destroyNamespace(id);
      const reason = String(error.message ?? error);
      entry.error = reason;
      entry.refused = looksRefused(reason);
      logError(`VPN ${id} failed: ${reason}`);
      throw new Error(reason);
    }
  })().finally(() => {
    const current = networks.get(id);
    if (current) current.raising = null;
  });

  return entry.raising;
}

async function dropTunnel(id) {
  const entry = networks.get(id);
  if (!entry?.tunnel) return;
  const { procs } = entry.tunnel;
  entry.tunnel = null;
  for (const proc of procs) {
    try {
      proc.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  await destroyNamespace(id);
  log(`VPN ${id} taken down`);
}

function noteIdle(id) {
  const entry = networks.get(id);
  if (!entry || entry.live > 0) return;
  clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    const current = networks.get(id);
    if (current && current.live === 0) void dropTunnel(id);
  }, IDLE_MS);
  entry.idleTimer.unref();
}

/**
 * The doorway outlives the tunnel, which is the whole of on-demand.
 *
 * It listens for as long as the VPN is registered. A connection arriving to a
 * VPN that is down raises it and then waits; when the last connection goes,
 * the tunnel follows it after a while. Nothing else has to know when a
 * session starts or ends -- being connected to is what "in use" means.
 */
function openDoorway(id) {
  const port = DOOR_BASE + id;
  const { peer } = addresses(id);

  const server = net.createServer(async (client) => {
    const entry = networks.get(id);
    if (!entry) return client.destroy();

    entry.live += 1;
    clearTimeout(entry.idleTimer);

    const finish = () => {
      const current = networks.get(id);
      if (!current) return;
      current.live = Math.max(0, current.live - 1);
      noteIdle(id);
    };

    client.once("close", finish);
    client.on("error", () => client.destroy());

    try {
      await raiseTunnel(id);
    } catch {
      // The reason is recorded on the entry and reported through NSTA; here
      // there is nothing to say it to but a socket.
      return client.destroy();
    }

    const upstream = net.connect(1080, peer);
    const drop = () => {
      client.destroy();
      upstream.destroy();
    };
    upstream.on("error", drop);
    client.pipe(upstream).pipe(client);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => resolve({ server, port }));
  });
}

/**
 * Registering a VPN opens its doorway; it does not raise the tunnel.
 *
 * Raising happens when something connects. Termix asks for this at boot and
 * whenever a profile is saved, so the address is ready to be used long before
 * anything uses it.
 */
async function registerNetwork(profile, credentials) {
  const id = Number(profile.id);
  const existing = networks.get(id);

  if (existing) {
    // Edited: the server, the account or the pin may be what changed, so what
    // is running was built from the old ones.
    await dropTunnel(id);
    existing.profile = profile;
    existing.credentials = credentials;
    existing.refused = false;
    existing.error = null;
    return { state: stateOf(existing), port: existing.port };
  }

  const entry = {
    profile,
    credentials,
    doorway: null,
    port: DOOR_BASE + id,
    live: 0,
    tunnel: null,
    raising: null,
    refused: false,
    error: null,
    idleTimer: null,
  };
  networks.set(id, entry);

  try {
    const { server, port } = await openDoorway(id);
    entry.doorway = server;
    entry.port = port;
    log(`VPN ${id} is available on :${port}`);
    return { state: "idle", port };
  } catch (error) {
    networks.delete(id);
    const reason = String(error.message ?? error);
    logError(`VPN ${id} could not be made available: ${reason}`);
    return { state: "error", error: reason, port: DOOR_BASE + id };
  }
}

async function unregisterNetwork(id) {
  const entry = networks.get(id);
  if (entry) {
    clearTimeout(entry.idleTimer);
    await dropTunnel(id);
    entry.doorway?.close();
    networks.delete(id);
  }
  await destroyNamespace(id);
}

function snapshot() {
  return Array.from(networks.entries()).map(([id, entry]) => ({
    id,
    state: stateOf(entry),
    error: entry.error ?? null,
    port: entry.port,
    live: entry.live,
  }));
}
// ------------------------------------------------------------- control

async function handleFrame(magic, payload) {
  const body = payload.length > 0 ? JSON.parse(payload.toString("utf8")) : {};

  // Every message proves who is speaking before anything is acted on; the
  // credentials then arrive sealed under a key derived from the same secret.
  if (body.token !== TOKEN) {
    return { ok: false, error: "unauthorized" };
  }

  switch (magic.trimEnd()) {
    case "NUP": {
      if (!body.profile?.id)
        return { ok: false, error: "profile id is required" };
      const credentials = unseal(body.credentials);
      const result = await registerNetwork(body.profile, credentials);
      // "Available" is the answer now, not "up": the tunnel comes when
      // something connects. Anything but an error is a VPN that can be used.
      return { ok: result.state !== "error", ...result };
    }
    case "NDWN": {
      await unregisterNetwork(Number(body.id));
      return { ok: true, state: "down" };
    }
    case "NSTA":
      return { ok: true, networks: snapshot() };
    default:
      return { ok: false, error: `unknown message: ${magic}` };
  }
}

const server = net.createServer((socket) => {
  socket.on("error", () => socket.destroy());
  socket.on(
    "data",
    createFrameReader(async (magic, payload) => {
      let answer;
      try {
        answer = await handleFrame(magic, payload);
      } catch (error) {
        answer = { ok: false, error: String(error?.message ?? error) };
      }
      if (!socket.destroyed) {
        socket.write(
          encodeFrame("NRES", Buffer.from(JSON.stringify(answer), "utf8")),
        );
      }
    }),
  );
});

server.listen(PORT, BIND, () => log(`listening on ${BIND}:${PORT}`));

const shutdown = async () => {
  log("stopping; taking every network down with it");
  for (const id of Array.from(networks.keys())) await unregisterNetwork(id);
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
