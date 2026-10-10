/**
 * Credentials left behind when the VPN moved out of core.
 *
 * Core kept `gatewayPassword`, `authPassword` and `extraConfig` encrypted
 * under each owner's own data key and decrypted them on the way out. The
 * plugin stores them the way every other plugin stores a secret, so nothing
 * decrypts a row written before the move, and what reaches the gateway is the
 * envelope rather than the password.
 *
 * That is not a theory: a 36-character NetBird setup key, encrypted at insert
 * time, is exactly 270 characters, and NetBird refused it with "invalid
 * setup-key ... invalid UUID length: 270".
 *
 * They cannot be recovered here. The key belongs to the owner and exists only
 * while they are signed in, so a profile in this state is named rather than
 * used -- a gateway refusing an unreadable password looks like a wrong
 * password, and that is a long way from the truth.
 */

/** One of core's field envelopes, rather than a password someone typed. */
export function isLegacyEnvelope(value: unknown): boolean {
  if (typeof value !== "string" || !value.startsWith("{")) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const envelope = parsed as Record<string, unknown>;
  // All four, because extraConfig legitimately holds JSON of its own.
  return (
    typeof envelope.data === "string" &&
    typeof envelope.iv === "string" &&
    typeof envelope.tag === "string" &&
    typeof envelope.salt === "string"
  );
}

const SECRET_FIELDS = [
  "gatewayPassword",
  "authPassword",
  "extraConfig",
] as const;

/**
 * Refuses a profile whose secrets are still core's envelopes. Says what to do
 * about it, because nothing the operator can see explains the failure.
 */
export function assertSecretsReadable(
  profile: Partial<Record<(typeof SECRET_FIELDS)[number], unknown>>,
): void {
  const stale = SECRET_FIELDS.filter((field) =>
    isLegacyEnvelope(profile[field]),
  );
  if (stale.length === 0) return;

  throw new Error(
    "This VPN's credentials were saved by an older version and can no longer be read. " +
      "Open the VPN, enter them again and save it.",
  );
}
