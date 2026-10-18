/**
 * Why openconnect would not accept the gateway's certificate.
 *
 * Its last word for every one of these is "Failed to complete authentication"
 * -- the same thing it says when a password is refused, and nothing a person
 * could act on. One of them has already cost an investigation of a
 * certificate store that turned out to be complete, against a chain that
 * verifies: the reason was in the container's log and the operator saw a
 * gateway that would not sign in.
 *
 * A module of its own so it can be tested. manager.js opens its control
 * socket the moment it is imported, so nothing can import it to ask a
 * question.
 */

/**
 * Did the gateway's certificate stop matching the one this VPN pinned?
 *
 * A renewed certificate is fixed by updating the profile, not by checking
 * the password. openconnect prints the certificate's current pin when it
 * rejects one, so the value needed to fix it is carried along rather than
 * left to be worked out with openssl.
 */
export function pinnedCertificateChanged(said) {
  for (const line of said ?? []) {
    const match = /match server's certificate:\s*(pin-sha256:\S+)/i.exec(line);
    if (match) {
      return `the gateway's certificate no longer matches this VPN's pinned fingerprint. Its current pin is ${match[1]} -- update the profile's trusted fingerprint if this change was expected`;
    }
  }
  return null;
}

/**
 * Could the certificate not be verified at all?
 *
 * The profile pinned nothing, so it is judged against the container's root
 * store and openconnect refuses what it cannot build a chain for. A few lines
 * before giving up it prints the reason and the pin it would accept, and both
 * are carried out: the two things this can mean are acted on differently. A
 * gateway whose chain is genuinely incomplete is fixed by pinning it, and a
 * certificate nobody expected means something is sitting in the middle of the
 * connection.
 */
export function certificateUnverified(said) {
  let reason = null;
  let pin = null;
  for (const line of said ?? []) {
    const why = /^Reason:\s*(.+?)\s*$/i.exec(line);
    if (why) reason = why[1];
    const suggested = /--servercert\s+(pin-sha256:\S+)/i.exec(line);
    if (suggested) pin = suggested[1];
  }
  if (!reason && !pin) return null;
  return (
    `the gateway's certificate could not be verified${reason ? ` (${reason})` : ""}. ` +
    `It presents ${pin ?? "a certificate this container does not trust"} -- ` +
    "set that as the profile's trusted fingerprint if it is the right gateway, " +
    "and look for something intercepting the connection if it is not"
  );
}

/** Whichever of the two the client complained about, in words to act on. */
export function certificateComplaint(said) {
  return pinnedCertificateChanged(said) ?? certificateUnverified(said);
}
