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

// ------------------------------------------------------------- doorway

/**
 * The namespace's doorway is only reachable from inside this container, so
 * Termix is given one here that carries connections across. The port is
 * computed from the id, which is why a restart does not have to be announced.
 */
function openDoorway(id, peerAddress) {
  const port = DOOR_BASE + id;
  const server = net.createServer((client) => {
    const upstream = net.connect(1080, peerAddress);
    const drop = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", drop);
    upstream.on("error", drop);
    client.pipe(upstream).pipe(client);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => resolve({ server, port }));
  });
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

// ------------------------------------------------------------- lifecycle

/** id -> { state, error, port, procs, doorway } */
const networks = new Map();

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

async function bringUp(profile, credentials) {
  const id = Number(profile.id);
  await bringDown(id);

  await ensureForwarding();
  const { ns, peer } = await createNamespace(id);
  const entry = {
    state: "connecting",
    error: null,
    port: DOOR_BASE + id,
    procs: [],
    doorway: null,
    ns,
  };
  networks.set(id, entry);

  try {
    // Named gateways have to resolve before the namespace's rules exist; this
    // container's resolver is what answers, since the tunnel is not up yet.
    const gatewayIps = await resolveGatewayIps(profile.serverHost);
    const { command, args, iface, stdin } = buildProviderCommand(
      profile,
      credentials,
      gatewayIps,
    );

    /*
     * The client's own words are kept, because they are the answer.
     *
     * "The VPN client exited" tells an operator nothing; "authentication
     * failed" or "certificate does not match" tells them what to change. The
     * output still goes to the log, and the tail of it goes back to Termix.
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

    const vpn = spawn(...inNamespace(id, command, args), {
      stdio: ["pipe", "pipe", "pipe"],
    });
    vpn.stdout.on("data", remember);
    vpn.stderr.on("data", remember);
    entry.procs.push(vpn);
    entry.said = said;
    vpn.stdin.end(stdin);
    vpn.on("exit", (code) => {
      const current = networks.get(id);
      if (!current || current.procs[0] !== vpn) return;
      current.state = "down";
      current.error = `the VPN client exited (${code})`;
      // The doorway must never outlive the tunnel: a connection handed to it
      // would leave by this container's route instead of the VPN.
      current.doorway?.close();
      current.doorway = null;
      log(`network ${id}: tunnel ended (${code})`);
    });

    await waitForInterface(id, iface, vpn, 60000, said);
    await applyStrictRoutes(id, iface, gatewayIps);

    const socks = spawn(
      ...inNamespace(id, "microsocks", ["-i", peer, "-p", "1080"]),
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    entry.procs.push(socks);

    const { server, port } = await openDoorway(id, peer);
    entry.doorway = server;
    entry.state = "up";
    entry.error = null;
    log(`network ${id} is up on :${port}`);
    return { state: "up", port };
  } catch (error) {
    await bringDown(id);
    const entry2 = {
      state: "error",
      error: String(error.message ?? error),
      port: DOOR_BASE + id,
    };
    networks.set(id, entry2);
    logError(`network ${id} failed: ${entry2.error}`);
    return { state: "error", error: entry2.error, port: entry2.port };
  }
}

async function bringDown(id) {
  const entry = networks.get(id);
  if (entry) {
    entry.doorway?.close();
    for (const proc of entry.procs ?? []) {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
    networks.delete(id);
  }
  await destroyNamespace(id);
}

function snapshot() {
  return Array.from(networks.entries()).map(([id, entry]) => ({
    id,
    state: entry.state,
    error: entry.error ?? null,
    port: entry.port,
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
      const result = await bringUp(body.profile, credentials);
      return { ok: result.state === "up", ...result };
    }
    case "NDWN": {
      await bringDown(Number(body.id));
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
  for (const id of Array.from(networks.keys())) await bringDown(id);
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
