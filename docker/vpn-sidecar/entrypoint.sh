#!/bin/bash
set -euo pipefail

# The doorway must never outlive the tunnel.
#
# If openfortivpn dies and microsocks keeps listening, Termix would still be
# handed connections -- which would then leave by this container's own route
# instead of the VPN, silently, for a host configured precisely to avoid that.
# So the tunnel is the container's life: when it ends, everything ends, and
# Termix's next connection fails instead of leaking.

: "${VPN_HOST:?VPN_HOST is required (the FortiGate address)}"
: "${VPN_PORT:=443}"
: "${VPN_USER:?VPN_USER is required}"
: "${VPN_PASSWORD:?VPN_PASSWORD is required}"
: "${SOCKS_PORT:=1080}"
: "${VPN_TRUSTED_CERT:=}"
: "${VPN_TRUSTED_PIN:=}"
: "${VPN_CLIENT:=openfortivpn}"
: "${SOCKS_USER:=}"
: "${SOCKS_PASSWORD:=}"

# A doorway that is only reachable from Termix's own Docker network needs no
# password. One reachable from anywhere else is a way into the VPN for whoever
# finds the port, so it does need one -- and half a credential is not one.
if [[ -n "$SOCKS_USER" && -z "$SOCKS_PASSWORD" ]] \
   || [[ -z "$SOCKS_USER" && -n "$SOCKS_PASSWORD" ]]; then
  echo "[vpn-sidecar] SOCKS_USER and SOCKS_PASSWORD must be set together" >&2
  exit 1
fi

cleanup() {
  [[ -n "${SOCKS_PID:-}" ]] && kill "$SOCKS_PID" 2>/dev/null || true
  [[ -n "${VPN_PID:-}" ]] && kill "$VPN_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Both clients speak FortiGate SSL-VPN. They differ in what the kernel has to
# offer them: openfortivpn drives pppd and needs /dev/ppp, openconnect makes a
# tun device and needs /dev/net/tun. An unprivileged container host often has
# the second and not the first.
case "$VPN_CLIENT" in
  openfortivpn)
    VPN_IFACE=ppp0
    args=("$VPN_HOST:$VPN_PORT" -u "$VPN_USER" --pppd-use-peerdns=1)
    [[ -n "$VPN_TRUSTED_CERT" ]] && args+=(--trusted-cert "$VPN_TRUSTED_CERT")
    [[ -n "${VPN_OTP:-}" ]] && args+=(--otp "$VPN_OTP")
    ;;
  openconnect)
    VPN_IFACE=tun0
    args=(--protocol=fortinet --user "$VPN_USER" --passwd-on-stdin
          --interface "$VPN_IFACE" --non-inter)
    # Not the same number. openfortivpn pins the certificate; openconnect pins
    # the public key inside it, base64 rather than hex. Passing one where the
    # other is meant fails to match, which looks exactly like a wrong gateway.
    if [[ -n "$VPN_TRUSTED_PIN" ]]; then
      args+=(--servercert "pin-sha256:${VPN_TRUSTED_PIN#pin-sha256:}")
    elif [[ -n "$VPN_TRUSTED_CERT" ]]; then
      echo "[vpn-sidecar] openconnect needs VPN_TRUSTED_PIN, not VPN_TRUSTED_CERT." >&2
      echo "[vpn-sidecar] Get it with:" >&2
      echo "[vpn-sidecar]   openssl s_client -connect $VPN_HOST:$VPN_PORT -servername $VPN_HOST </dev/null 2>/dev/null \\" >&2
      echo "[vpn-sidecar]     | openssl x509 -pubkey -noout | openssl pkey -pubin -outform DER \\" >&2
      echo "[vpn-sidecar]     | openssl dgst -sha256 -binary | base64" >&2
      exit 1
    fi
    args+=("https://$VPN_HOST:$VPN_PORT")
    ;;
  *)
    echo "[vpn-sidecar] VPN_CLIENT must be openfortivpn or openconnect" >&2
    exit 1
    ;;
esac

echo "[vpn-sidecar] connecting to $VPN_HOST:$VPN_PORT as $VPN_USER via $VPN_CLIENT"
printf '%s\n' "$VPN_PASSWORD" | "$VPN_CLIENT" "${args[@]}" &
VPN_PID=$!

# Wait for the tunnel to actually come up rather than assuming it did.
for _ in $(seq 1 60); do
  if ip link show "$VPN_IFACE" >/dev/null 2>&1; then
    echo "[vpn-sidecar] $VPN_IFACE is up"
    break
  fi
  if ! kill -0 "$VPN_PID" 2>/dev/null; then
    echo "[vpn-sidecar] $VPN_CLIENT exited before the tunnel came up" >&2
    exit 1
  fi
  sleep 1
done

if ! ip link show "$VPN_IFACE" >/dev/null 2>&1; then
  echo "[vpn-sidecar] the tunnel did not come up within 60s" >&2
  exit 1
fi

socks_args=(-i 0.0.0.0 -p "$SOCKS_PORT")
if [[ -n "$SOCKS_USER" ]]; then
  socks_args+=(-u "$SOCKS_USER" -P "$SOCKS_PASSWORD")
  echo "[vpn-sidecar] doorway listening on :$SOCKS_PORT (password required)"
else
  echo "[vpn-sidecar] doorway listening on :$SOCKS_PORT (no password -- keep this off any network but Termix's)"
fi
microsocks "${socks_args[@]}" &
SOCKS_PID=$!

# Whichever ends first ends the container; the restart policy decides what
# happens next, and until then Termix has nowhere to hand traffic to.
wait -n "$VPN_PID" "$SOCKS_PID"
echo "[vpn-sidecar] tunnel or doorway ended; stopping" >&2
exit 1
