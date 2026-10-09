import net from "node:net";
import fs from "node:fs";
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
/** Each tailscaled gets its own SOCKS port, since they share this namespace. */
const TAILSCALE_SOCKS_BASE = Number(
  process.env.NET_MANAGER_TAILSCALE_SOCKS_BASE ?? 30000,
);
/** The same for netbird, in a range of its own so the two never collide. */
const NETBIRD_SOCKS_BASE = Number(
  process.env.NET_MANAGER_NETBIRD_SOCKS_BASE ?? 31000,
);
/**
 * Where a peer's identity is kept, for the providers that have one.
 *
 * Meant to be a mounted volume. Left inside the container, it is destroyed
 * every time the container is recreated -- which is what pulling a new image
 * does -- and the peer then registers again from nothing, spending one more
 * use of the setup key. A single-use key is spent the first time that
 * happens, and the network stops coming up with "setup key is invalid".
 */
const STATE_ROOT =
  process.env.NET_MANAGER_STATE_ROOT ?? "/var/lib/termix-netmgr";

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

/**
 * A failed command reports what it was, with the secrets taken out.
 *
 * The reason travels back to Termix and is shown to whoever is looking, so an
 * auth key or a password on the command line would end up in the database and
 * on the screen. What is useful about the command is its shape, not its
 * credentials.
 */
/*
 * Named by what they are, not by one vendor's spelling. Netbird calls its
 * secret --setup-key and that was missed once, so the key reached the
 * database and the screen; anything whose name says key, password, token or
 * secret is hidden now, whoever's flag it is.
 */
const SECRET_ARG = /^--[a-z0-9-]*(key|pass(word|wd)?|token|secret)[a-z0-9-]*=/i;

function redactArgs(args) {
  return args.map((arg) =>
    SECRET_ARG.test(arg) ? arg.replace(/=.*/, "=***") : arg,
  );
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.message = `${command} ${redactArgs(args).join(" ")}: ${stderr || error.message}`;
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

/*
 * A refusal is not a failure to retry.
 *
 * A dropped tunnel is worth raising again; a credential the gateway refused is
 * not. Trying it again cannot succeed, and a gateway counts the attempts --
 * which is how an account gets locked, and then stays locked, because the next
 * attempt arrives before the lockout lapses. With a doorway that raises on
 * demand this matters twice over: without it, every connection would be
 * another attempt.
 */
/**
 * A reason that will read the same way next time.
 *
 * Retrying such a credential is how a real account got locked out once, so
 * these are recorded and not tried again until the profile is edited. The
 * list names refusals only: a certificate that will not verify or a node
 * waiting on an admin's approval are left out, because re-saving the profile
 * is not what fixes either of them.
 */
function looksRefused(reason) {
  return /authentication (failed|error)|failed to complete authentication|login failed|permission denied|user input required|invalid credential|invalid key|key is expired|expired key|setup[- ]key (is |was )?(invalid|expired|exhausted|revoked)|invalid setup-key|no longer matches this VPN's pinned/i.test(
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

/** Waits for an interface to appear inside the namespace, and gives up with
 * the client's own words when the client dies first. */
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

/**
 * A provider raises a tunnel and says where its doorway is.
 *
 * The two that exist differ at every step, which is why this is a function
 * each rather than a table of flags: openconnect needs a network namespace,
 * makes a tun device and has microsocks put in front of it; tailscaled needs
 * none of that, because it carries its own network stack and its own SOCKS
 * server.
 *
 * What they agree on is the answer: the processes that make up the tunnel,
 * and an address the doorway can hand connections to.
 */

/** Keeps the client's own words, which are usually the reason it failed. */
function watcher() {
  const said = [];
  return {
    said,
    attach(proc) {
      const remember = (chunk) => {
        process.stderr.write(chunk);
        for (const line of chunk.toString().split("\n")) {
          const text = line.trim();
          if (text) said.push(text);
        }
        if (said.length > 40) said.splice(0, said.length - 40);
      };
      proc.stdout?.on("data", remember);
      proc.stderr?.on("data", remember);
    },
  };
}

/**
 * Did the gateway's certificate stop matching the one this VPN pinned?
 *
 * Worth telling apart, because openconnect's last word for it is "Failed to
 * complete authentication" -- the same thing it says when a password is
 * refused, and nothing a person could act on. A renewed certificate is fixed
 * by updating the profile, not by checking the password.
 *
 * openconnect prints the certificate's current pin when it rejects one, so
 * the value needed to fix it is carried along rather than left to be worked
 * out with openssl.
 */
function pinnedCertificateChanged(said) {
  for (const line of said ?? []) {
    const match = /match server's certificate:\s*(pin-sha256:\S+)/i.exec(line);
    if (match) {
      return `the gateway's certificate no longer matches this VPN's pinned fingerprint. Its current pin is ${match[1]} -- update the profile's trusted fingerprint if this change was expected`;
    }
  }
  return null;
}

async function raiseFortinet({ id, profile, credentials, watch, procs }) {
  const { peer } = addresses(id);
  const host = profile.serverHost;

  // Named gateways have to resolve before the namespace's rules exist; this
  // container's resolver is what answers, since the tunnel is not up yet.
  const gatewayIps = await resolveGatewayIps(host);

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

  const vpn = spawn(...inNamespace(id, "openconnect", args), {
    stdio: ["pipe", "pipe", "pipe"],
  });
  watch.attach(vpn);
  procs.push(vpn);
  vpn.stdin.end(`${credentials.password}\n`);

  try {
    await waitForInterface(id, "tun0", vpn, 60000, watch.said);
  } catch (error) {
    // A pinned certificate that changed says so plainly, rather than through
    // openconnect's parting words about authentication.
    const changed = pinnedCertificateChanged(watch.said);
    throw changed ? new Error(changed) : error;
  }
  await applyStrictRoutes(id, "tun0", gatewayIps);

  const socks = spawn(
    ...inNamespace(id, "microsocks", ["-i", peer, "-p", "1080"]),
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  procs.push(socks);

  return { upstream: { host: peer, port: 1080 } };
}

/**
 * Tailscale needs none of what Fortinet needs.
 *
 * With userspace networking it builds its own network stack instead of a tun
 * device, so there is no interface to wait for, no kernel route to collide
 * with another tailnet's, and no namespace to keep them apart. And it puts a
 * SOCKS5 server in front of that stack itself, which is the doorway this
 * manager otherwise assembles out of microsocks.
 *
 * The node is not kept: --state=mem: means a fresh one each time the tunnel
 * comes up, which is what an ephemeral auth key is for. Keeping state would
 * leave a trail of dead nodes in the tailnet, since this raises and drops
 * with use.
 */
async function raiseTailscale({ id, profile, credentials, watch, procs }) {
  const socksPort = TAILSCALE_SOCKS_BASE + id;
  const socket = `/run/tailscale-${id}.sock`;

  const daemon = spawn(
    "tailscaled",
    [
      "--tun=userspace-networking",
      `--socks5-server=127.0.0.1:${socksPort}`,
      "--state=mem:",
      `--socket=${socket}`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  watch.attach(daemon);
  procs.push(daemon);

  const up = ["--socket=" + socket, "up", `--hostname=termix-${id}`];
  if (credentials.password) up.push(`--authkey=${credentials.password}`);
  // A self-hosted control server (Headscale) goes here; empty means Tailscale's.
  if (profile.serverHost) up.push(`--login-server=${profile.serverHost}`);

  await waitForTailscale(daemon, socket, up, watch.said);

  return {
    upstream: { host: "127.0.0.1", port: socksPort },
    resolve: async (name) => {
      const status = JSON.parse(
        await run("tailscale", [`--socket=${socket}`, "status", "--json"]),
      );
      const nodes = [status.Self, ...Object.values(status.Peer ?? {})];
      return matchPeer(
        name,
        nodes.filter(Boolean).map((node) => ({
          names: [node.DNSName, node.HostName],
          ip: firstIPv4(node.TailscaleIPs),
        })),
      );
    },
  };
}

/** The daemon has to be listening on its socket before it will take a login,
 * and the login is what decides whether these credentials are any good. */
async function waitForTailscale(
  daemon,
  socket,
  upArgs,
  said,
  timeoutMs = 60000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (daemon.exitCode !== null) {
      const reason = lastWords(said);
      throw new Error(
        reason ? `tailscaled stopped: ${reason}` : "tailscaled exited at once",
      );
    }
    try {
      await run("tailscale", [`--socket=${socket}`, "status", "--json"]);
      break;
    } catch {
      if (Date.now() > deadline) {
        throw new Error("tailscaled never answered on its socket");
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  try {
    await run("tailscale", upArgs);
  } catch (error) {
    // The CLI's own words: an auth key that is used up, expired or meant for
    // another tailnet each say so, and each needs a different answer.
    throw new Error(
      `tailscale could not sign in: ${String(error.message ?? error).trim()}`,
    );
  }
}

/**
 * Netbird, by the same arrangement as Tailscale and for the same reason.
 *
 * Netstack mode gives it a network stack of its own instead of a wireguard
 * device, and a SOCKS5 server in front of that stack -- so, like a tailnet, it
 * needs no namespace, no privileges and no doorway built out of microsocks.
 *
 * Everything that separates one netbird from another is passed in the
 * environment, not on the command line. The --daemon-addr flag is accepted
 * and then ignored: a second daemon started with it tried to bind the default
 * socket anyway, and a CLI pointed at one instance with it quietly configured
 * whichever instance owned the default. Measured, both of them.
 *
 * The peer's identity is kept, unlike the tailnet's. Netbird has no in-memory
 * state option, and keeping it means a network that goes up and down with use
 * comes back as the same peer rather than leaving a new dead one behind each
 * time -- and, across a restart, without spending another use of the setup
 * key. It lives under STATE_ROOT for that second reason; the socket does not,
 * because a socket outlives nothing.
 */
/**
 * Keep a peer's identity only while it still belongs to the credentials that
 * made it.
 *
 * The identity outliving the container is the point of STATE_ROOT, but it
 * must not outlive the setup key it registered with. A key that was rotated,
 * or a peer deleted from the dashboard, leaves a stored identity the daemon
 * keeps presenting -- and then entering a new key in Termix changes nothing,
 * because nothing asks the control server again. That is a hole with no way
 * out from the UI, so the identity is dropped as soon as what it was built
 * from no longer matches.
 *
 * Only a fingerprint is written down, never the key.
 */
async function useStateFor(state, key, server) {
  const want = crypto
    .createHash("sha256")
    .update(`${key ?? ""}\u0000${server ?? ""}`)
    .digest("hex");
  const stamp = `${state}/.termix-credentials`;

  let have = null;
  try {
    have = (await fs.promises.readFile(stamp, "utf8")).trim();
  } catch {
    /* never raised with these, or never raised at all */
  }

  if (have !== want) {
    if (have !== null) {
      log(`VPN state for ${state} was built from other credentials; dropping`);
    }
    await fs.promises.rm(state, { recursive: true, force: true });
  }

  await fs.promises.mkdir(state, { recursive: true });
  await fs.promises.writeFile(stamp, want, { mode: 0o600 });
}

async function raiseNetbird({ id, profile, credentials, watch, procs }) {
  const socksPort = NETBIRD_SOCKS_BASE + id;
  const state = `${STATE_ROOT}/netbird-${id}`;
  const daemonAddr = `unix:///run/netbird-${id}.sock`;
  await useStateFor(state, credentials.password, profile.serverHost);

  const environment = {
    ...process.env,
    NB_DAEMON_ADDR: daemonAddr,
    NB_USE_NETSTACK_MODE: "true",
    NB_SOCKS5_LISTENER_ADDRESS: "127.0.0.1",
    NB_SOCKS5_LISTENER_PORT: String(socksPort),
    NB_STATE_DIR: state,
    // Where the profile and config land; without it every instance shares one.
    HOME: state,
  };

  const daemon = spawn("netbird", ["service", "run", "--log-file", "console"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: environment,
  });
  watch.attach(daemon);
  procs.push(daemon);

  const up = [
    "up",
    `--hostname=termix-${id}`,
    `--setup-key=${credentials.password}`,
  ];
  // A self-hosted management server goes here; empty means Netbird's own.
  if (profile.serverHost) up.push(`--management-url=${profile.serverHost}`);

  await waitForNetbird(
    daemon,
    environment,
    up,
    watch.said,
    // Which server was asked. A key belongs to one network, so a key the
    // server calls invalid is as often the wrong server as the wrong key --
    // and an empty field means Netbird's own cloud, which is not where a
    // self-hosted network's keys live.
    profile.serverHost || "Netbird's own (netbird.io)",
  );

  return {
    upstream: { host: "127.0.0.1", port: socksPort },
    resolve: async (name) => {
      const status = JSON.parse(
        await run("netbird", ["status", "-j"], { env: environment }),
      );
      const peers = Array.isArray(status.peers?.details)
        ? status.peers.details
        : [];
      return matchPeer(
        name,
        [{ fqdn: status.fqdn, netbirdIp: status.netbirdIp }, ...peers].map(
          (peer) => ({ names: [peer.fqdn], ip: peer.netbirdIp }),
        ),
      );
    },
  };
}

/**
 * Sign in, and stop as soon as the answer is no.
 *
 * `netbird up` does not give up on a rejected setup key for nearly two
 * minutes -- measured at 1m49s -- while the daemon says why within a second.
 * A connection is waiting on this, so the daemon's word is taken as soon as
 * it arrives rather than sitting out the retries.
 */
async function waitForNetbird(
  daemon,
  environment,
  upArgs,
  said,
  management,
  timeoutMs = 60000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (daemon.exitCode !== null) {
      const reason = lastWords(said);
      throw new Error(
        reason ? `netbird stopped: ${reason}` : "netbird exited at once",
      );
    }
    try {
      await run("netbird", ["status"], { env: environment });
      break;
    } catch {
      if (Date.now() > deadline) {
        throw new Error("the netbird daemon never answered on its socket");
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  const signIn = run("netbird", upArgs, { env: environment });
  // The race may be decided before this settles, and a rejection nobody is
  // listening to any more would take the manager down with it.
  signIn.catch(() => {});

  const refusal = watchForRefusal(said);
  try {
    await Promise.race([signIn, refusal.promise]);
  } catch (error) {
    throw new Error(
      `netbird could not sign in to ${management}: ${String(
        error.message ?? error,
      ).trim()}`,
    );
  } finally {
    refusal.stop();
  }
}

/**
 * A promise that settles when the tunnel's own output says it was refused.
 *
 * Only refusals count. A process that merely has not succeeded yet is still
 * worth waiting for; one that has been told no is not.
 */
function watchForRefusal(said) {
  let timer;
  const promise = new Promise((_resolve, reject) => {
    timer = setInterval(() => {
      const refusal = said.find((line) => looksRefused(line));
      if (refusal) reject(new Error(refusal));
    }, 250);
  });
  promise.catch(() => {});
  return { promise, stop: () => clearInterval(timer) };
}

const PROVIDERS = {
  fortinet: { needsNamespace: true, raise: raiseFortinet },
  tailscale: { needsNamespace: false, raise: raiseTailscale },
  netbird: { needsNamespace: false, raise: raiseNetbird },
};

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

/**
 * Find a name in a network that keeps its own list of them.
 *
 * A mesh gives its members names that exist nowhere else, so the resolver on
 * this machine cannot answer for them and the gateway's SOCKS5 server, asked
 * for one, says the host is unreachable. The network itself knows, though, so
 * it is asked directly rather than through DNS.
 *
 * A short name is accepted as well as the full one, because that is what
 * people type and the first label is what distinguishes a peer.
 */
function matchPeer(name, entries) {
  const wanted = String(name).trim().toLowerCase().replace(/\.$/, "");
  if (!wanted) return null;

  for (const entry of entries) {
    if (!entry.ip) continue;
    for (const candidate of entry.names) {
      if (!candidate) continue;
      const full = String(candidate).toLowerCase().replace(/\.$/, "");
      if (full === wanted || full.split(".")[0] === wanted) return entry.ip;
    }
  }
  return null;
}

/** A mesh hands out both families; the v4 address is the one to dial. */
function firstIPv4(addresses) {
  if (!Array.isArray(addresses)) return null;
  return addresses.find((address) => net.isIPv4(String(address))) ?? null;
}

/**
 * Answer what an address means inside one network.
 *
 * The tunnel has to be up to ask, and raising it is what the connection that
 * follows would have done anyway -- so this raises it rather than reporting
 * a name it could have looked up.
 */
async function resolveInNetwork(id, name) {
  const entry = networks.get(id);
  if (!entry) throw new Error("this VPN is not registered");
  await raiseTunnel(id);
  const resolve = networks.get(id)?.tunnel?.resolve;
  // A gateway without a list of its own leaves the name to the far side,
  // which is what happened before any of this existed.
  if (!resolve) return null;
  return resolve(name);
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
    const provider = PROVIDERS[profile.provider];
    if (!provider) {
      const reason = `unsupported provider: ${profile.provider}`;
      entry.error = reason;
      throw new Error(reason);
    }

    if (provider.needsNamespace) {
      await ensureForwarding();
      await createNamespace(id);
    }

    const watch = watcher();
    const procs = [];
    try {
      const { upstream, resolve } = await provider.raise({
        id,
        profile,
        credentials,
        watch,
        procs,
      });

      // The first process is the tunnel itself; when it goes, so does the
      // tunnel -- whatever is going through it must not leave by this
      // container's own route instead.
      procs[0]?.on("exit", (code) => {
        const current = networks.get(id);
        if (!current || current.tunnel?.procs[0] !== procs[0]) return;
        log(`VPN ${id}: tunnel ended (${code})`);
        void dropTunnel(id);
      });

      // Spawned is not listening. The connection that triggered this raise is
      // waiting to be handed over, and handing it over a moment too early
      // gets a refusal the caller sees as the socket closing.
      await waitForDoorwayUpstream(upstream);

      entry.tunnel = { procs, upstream, resolve, ns: nsName(id) };
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
      if (provider.needsNamespace) await destroyNamespace(id);
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

/** Poll until the namespace's SOCKS server accepts, so the waiting
 * connection is handed to something that answers. */
function waitForDoorwayUpstream(upstream, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const probe = net.connect(upstream.port, upstream.host);
      const retry = () => {
        probe.destroy();
        if (Date.now() > deadline) {
          return reject(
            new Error("the doorway inside the tunnel never opened"),
          );
        }
        setTimeout(attempt, 100);
      };
      probe.once("connect", () => {
        probe.destroy();
        resolve();
      });
      probe.once("error", retry);
      probe.setTimeout(1000, retry);
    };
    attempt();
  });
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
  if (PROVIDERS[entry.profile?.provider]?.needsNamespace) {
    await destroyNamespace(id);
  }
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

    // Where to hand it is the provider's answer, not this function's
    // arithmetic: one puts its doorway in a namespace, the other in its own
    // process.
    const to = networks.get(id)?.tunnel?.upstream;
    if (!to) return client.destroy();
    const upstream = net.connect(to.port, to.host);
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
    /*
     * Take the tunnel down, keep the doorway.
     *
     * Different from NDWN, which forgets the VPN entirely. This is someone
     * closing a VPN they are done with for now: the next session raises it
     * again, because it is still registered.
     */
    case "NDRP": {
      const id = Number(body.id);
      await dropTunnel(id);
      const entry = networks.get(id);
      return {
        ok: true,
        state: stateOf(entry),
        port: entry?.port ?? DOOR_BASE + id,
      };
    }
    /*
     * What does this name mean inside that network?
     *
     * Asked just before a session connects, so the address in the SOCKS5
     * request is one the gateway can route to.
     */
    case "NRES": {
      const id = Number(body.id);
      if (!id || !body.name) {
        return { ok: false, error: "id and name are required" };
      }
      const address = await resolveInNetwork(id, String(body.name));
      return { ok: true, address };
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
