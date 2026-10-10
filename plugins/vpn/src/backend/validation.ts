/**
 * What a network profile has to say before it can be saved.
 *
 * A profile that names no gateway is the same failure this fork just fixed in
 * the proxy path: a host marked "reach this through somewhere else" with no
 * somewhere else, connecting directly instead. Refusing it here means the
 * person sees why, while they are still looking at the form.
 */

/*
 * "declared" is no longer offered.
 *
 * It was the arrangement before Termix could raise a tunnel itself: the
 * operator ran a sidecar per network and a profile recorded its address. Two
 * ways to do one thing, and the one that needs a compose edit per customer is
 * the worse of them.
 *
 * Rows that already exist still resolve -- a profile someone is connecting
 * through is not a thing to break on an upgrade. Only making new ones is
 * closed, and only because nothing would be gained by it.
 */
const KINDS = new Set(["managed"]);
/**
 * What each provider needs, because they do not need the same things.
 *
 * A Fortinet gateway is dialled at an address as a named account. A tailnet
 * has no address to dial -- the node signs in to a control server with a key
 * and the tailnet finds itself -- so asking for a host and a username there
 * would refuse a profile that is perfectly complete.
 */
const PROVIDERS: Record<
  string,
  (data: Record<string, unknown>) => string | null
> = {
  fortinet: findFortinetError,
  tailscale: findTailscaleError,
  netbird: findNetbirdError,
};

export function findVpnProfileError(input: unknown): string | null {
  const data = (input ?? {}) as Record<string, unknown>;

  const name = data.name;
  if (typeof name !== "string" || name.trim().length === 0) {
    return "A network profile needs a name";
  }

  if (data.kind !== undefined && !KINDS.has(String(data.kind))) {
    return String(data.kind) === "declared"
      ? "Networks are raised by Termix now; an operator-run sidecar is no longer set up from here"
      : "Unsupported profile kind";
  }

  /*
   * A managed profile has no address to give: Termix raises the tunnel, so it
   * works the address out. What it needs instead is what to dial and as whom.
   */
  const provider = PROVIDERS[String(data.provider ?? "")];
  if (!provider) return "Unsupported VPN provider";
  return provider(data);
}

function findFortinetError(data: Record<string, unknown>): string | null {
  const server = data.serverHost;
  if (typeof server !== "string" || server.trim().length === 0) {
    return "A managed network needs the VPN gateway's address";
  }

  const portError = findPortError(data.serverPort);
  if (portError) return portError;

  const username = data.authUsername;
  if (typeof username !== "string" || username.trim().length === 0) {
    return "A managed network needs the VPN account's username";
  }

  return null;
}

/**
 * A tailnet needs a key and nothing else.
 *
 * The control server is optional because leaving it empty means Tailscale's
 * own; it is only set when the tailnet is self-hosted (Headscale). The key is
 * not optional: without one the node would ask a person to open a login page,
 * and there is no person here to open it.
 */
function findTailscaleError(data: Record<string, unknown>): string | null {
  return findKeyedProviderError(data, {
    missingKey: "A tailnet needs an auth key to sign in with",
    badServer:
      "A self-hosted control server is a URL, such as https://headscale.example.com",
  });
}

/** Netbird signs in the same way, and calls the two things by its own names. */
function findNetbirdError(data: Record<string, unknown>): string | null {
  return findKeyedProviderError(data, {
    missingKey: "A NetBird network needs a setup key to sign in with",
    badServer:
      "A self-hosted management server is a URL, such as https://netbird.example.com",
  });
}

/**
 * The shape both userspace providers share: a key, and a server only when the
 * network is self-hosted rather than the vendor's own.
 */
function findKeyedProviderError(
  data: Record<string, unknown>,
  words: { missingKey: string; badServer: string },
): string | null {
  const key = data.authPassword;
  if (typeof key !== "string" || key.trim().length === 0) {
    return words.missingKey;
  }

  const server = data.serverHost;
  if (
    typeof server === "string" &&
    server.trim().length > 0 &&
    !/^https?:\/\/\S+$/i.test(server.trim())
  ) {
    return words.badServer;
  }

  return null;
}

function findPortError(port: unknown): string | null {
  if (port === undefined || port === null) return null;
  if (
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    return "A managed network needs a valid VPN gateway port";
  }
  return null;
}

/**
 * A host may only be put on a network its owner has.
 *
 * Profile ids are small integers and a profile reaches a gateway with stored
 * credentials, so without this a host could name someone else's network and
 * leave through it. The resolver refuses such a profile at connect time as
 * well; this is so the refusal arrives while the host is being saved, where
 * it can be understood.
 */
export async function vpnProfileAssignmentError(
  vpnProfileId: unknown,
  ownerId: string,
  findProfile: (id: number, userId: string) => Promise<unknown>,
): Promise<string | null> {
  if (vpnProfileId === undefined || vpnProfileId === null) return null;

  const id = Number(vpnProfileId);
  if (!Number.isInteger(id) || id <= 0) {
    return "Invalid VPN";
  }

  return (await findProfile(id, ownerId)) ? null : "VPN not found";
}
