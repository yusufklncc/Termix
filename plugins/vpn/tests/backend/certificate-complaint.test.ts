/**
 * What a rejected gateway certificate tells the operator.
 *
 * openconnect's last word for every certificate problem is "Failed to
 * complete authentication", which is also what it says when a password is
 * refused. That cost one investigation of a certificate store -- the store
 * turned out to be complete and the chain verifies with the same GnuTLS the
 * client uses, while the reason sat in the container's log and the operator
 * saw a VPN that would not sign in.
 *
 * The fixtures below are openconnect 9.12's own output, taken from the
 * published manager image, not written from memory.
 */

import { describe, expect, it } from "vitest";
import {
  certificateComplaint,
  certificateUnverified,
  pinnedCertificateChanged,
  // Plain JS, the file that ships in the manager image.
} from "../../../../docker/net-manager/certificate-complaint.js";

/** openconnect --protocol=fortinet --non-inter https://self-signed.badssl.com/ */
const UNTRUSTED = [
  "GET https://self-signed.badssl.com/",
  "Connected to 104.154.89.105:443",
  "SSL negotiation with self-signed.badssl.com",
  "Server certificate verify failed: signer not found",
  'Certificate from VPN server "self-signed.badssl.com" failed verification.',
  "Reason: signer not found",
  "To trust this server in future, perhaps add this to your command line:",
  "    --servercert pin-sha256:9SLklscvzMYj8f+52lp5ze/hY0CFHyLSPQzSpYYIBm8=",
  "SSL connection failure: Error in the certificate.",
  "Failed to open HTTPS connection to self-signed.badssl.com",
  "Failed to complete authentication",
];

const PIN_MISMATCH = [
  "SSL negotiation with vpn.example",
  "Server certificate does not match server's certificate: pin-sha256:QKUyCCTGeNQwQERAL56MX7DjLFC0sjLb0xn0jI2pYyk=",
  "Failed to complete authentication",
];

describe("a certificate that cannot be verified", () => {
  it("says so, with the reason the client gave", () => {
    const said = certificateUnverified(UNTRUSTED);
    expect(said).toContain("could not be verified");
    expect(said).toContain("signer not found");
  });

  it("carries the pin that would be accepted", () => {
    // So the operator can pin it without going to openssl, or recognise a
    // fingerprint that is not the gateway's.
    expect(certificateUnverified(UNTRUSTED)).toContain(
      "pin-sha256:9SLklscvzMYj8f+52lp5ze/hY0CFHyLSPQzSpYYIBm8=",
    );
  });

  it("names both things it can mean", () => {
    const said = certificateUnverified(UNTRUSTED);
    expect(said).toContain("trusted fingerprint");
    expect(said).toContain("intercepting");
  });

  it("says nothing about a failure that was not the certificate", () => {
    expect(
      certificateUnverified([
        "SSL negotiation with vpn.example",
        "Creating SSL connection failed",
        "Failed to complete authentication",
      ]),
    ).toBeNull();
  });
});

describe("the complaint the manager raises", () => {
  it("is the pin mismatch when that is what happened", () => {
    // A renewed certificate on a pinned profile: told apart because it is
    // fixed by updating the profile, not by looking for an interceptor.
    const said = certificateComplaint(PIN_MISMATCH);
    expect(said).toContain("no longer matches");
    expect(said).not.toContain("intercepting");
  });

  it("is the verification failure otherwise", () => {
    expect(certificateComplaint(UNTRUSTED)).toContain("could not be verified");
  });

  it("is nothing when the client said nothing about a certificate", () => {
    expect(certificateComplaint([])).toBeNull();
    expect(certificateComplaint(undefined)).toBeNull();
  });

  it("keeps the pinned case exactly as it was", () => {
    expect(pinnedCertificateChanged(PIN_MISMATCH)).toBe(
      certificateComplaint(PIN_MISMATCH),
    );
  });
});
