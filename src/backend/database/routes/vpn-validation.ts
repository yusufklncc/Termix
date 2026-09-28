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
/** One on purpose: the gateway this can be measured against. */
const PROVIDERS = new Set(["fortinet"]);

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
  return findManagedProfileError(data);
}

function findManagedProfileError(data: Record<string, unknown>): string | null {
  if (!PROVIDERS.has(String(data.provider ?? ""))) {
    return "Unsupported VPN provider";
  }

  const server = data.serverHost;
  if (typeof server !== "string" || server.trim().length === 0) {
    return "A managed network needs the VPN gateway's address";
  }

  const port = data.serverPort;
  if (
    port !== undefined &&
    port !== null &&
    (typeof port !== "number" ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535)
  ) {
    return "A managed network needs a valid VPN gateway port";
  }

  const username = data.authUsername;
  if (typeof username !== "string" || username.trim().length === 0) {
    return "A managed network needs the VPN account's username";
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
  findProfile: (id: number, userId: string) => Promise<unknown> = async (
    id,
    userId,
  ) =>
    (await import("../repositories/factory.js"))
      .createCurrentVpnProfileRepository()
      .findById(id, userId),
): Promise<string | null> {
  if (vpnProfileId === undefined || vpnProfileId === null) return null;

  const id = Number(vpnProfileId);
  if (!Number.isInteger(id) || id <= 0) {
    return "Invalid network profile";
  }

  return (await findProfile(id, ownerId)) ? null : "Network profile not found";
}
