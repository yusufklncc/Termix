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
: "${VPN_STRICT_ROUTES:=true}"
# How long to wait before letting the restart policy try again after the
# gateway refused the credentials. Retrying those achieves nothing and, on a
# FortiGate, locks the account -- so the wait is long on purpose.
: "${VPN_AUTH_BACKOFF:=900}"
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

# Was it the credentials, or the network?
#
# A dropped tunnel is worth reconnecting; a refused password is not. Trying it
# again cannot succeed, and a FortiGate counts the attempts: the restart policy
# turns one wrong password into a locked account within minutes. So a refusal
# waits instead, long enough for a lockout to lapse rather than renew it.
CLIENT_LOG=$(mktemp)
refused_credentials() {
  grep -qiE "authentication (failed|error)|login failed|permission denied|user input required" \
    "$CLIENT_LOG"
}
wait_out_a_refusal() {
  echo "[vpn-sidecar] the gateway refused these credentials." >&2
  echo "[vpn-sidecar] Retrying cannot help and locks the account, so this" >&2
  echo "[vpn-sidecar] waits ${VPN_AUTH_BACKOFF}s. Fix the credentials and" >&2
  echo "[vpn-sidecar] restart this container to try at once." >&2
  sleep "$VPN_AUTH_BACKOFF"
}

echo "[vpn-sidecar] connecting to $VPN_HOST:$VPN_PORT as $VPN_USER via $VPN_CLIENT"
# Process substitution rather than a pipe, so $! is the client and not tee --
# the supervision below asks whether *it* is still alive.
"$VPN_CLIENT" "${args[@]}" < <(printf '%s\n' "$VPN_PASSWORD") \
  > >(tee "$CLIENT_LOG") 2>&1 &
VPN_PID=$!

# Wait for the tunnel to actually come up rather than assuming it did.
for _ in $(seq 1 60); do
  if ip link show "$VPN_IFACE" >/dev/null 2>&1; then
    echo "[vpn-sidecar] $VPN_IFACE is up"
    break
  fi
  if ! kill -0 "$VPN_PID" 2>/dev/null; then
    echo "[vpn-sidecar] $VPN_CLIENT exited before the tunnel came up" >&2
    refused_credentials && wait_out_a_refusal
    exit 1
  fi
  sleep 1
done

if ! ip link show "$VPN_IFACE" >/dev/null 2>&1; then
  echo "[vpn-sidecar] the tunnel did not come up within 60s" >&2
  exit 1
fi

# Anything the tunnel does not carry must not leave by another way.
#
# A corporate VPN usually pushes split routes: some subnets go through it, the
# rest do not. Without this, a host whose address is outside those routes still
# connects -- out of this container's own internet route, quietly, for a host
# that was assigned to a network precisely so that would not happen. Dropping
# it turns a wrong answer into a refusal Termix can report.
apply_strict_routes() {
  local gateway_ips ip
  gateway_ips=$(getent ahostsv4 "$VPN_HOST" 2>/dev/null | awk '{print $1}' | sort -u)
  if [[ -z "$gateway_ips" ]]; then
    echo "[vpn-sidecar] cannot resolve $VPN_HOST to pin the tunnel's own route" >&2
    return 1
  fi

  iptables -F TERMIX_OUT 2>/dev/null || iptables -N TERMIX_OUT || return 1
  iptables -A TERMIX_OUT -o lo -j ACCEPT || return 1
  iptables -A TERMIX_OUT -o "$VPN_IFACE" -j ACCEPT || return 1
  # Replies to whoever reached the doorway, and the tunnel's own carrier.
  iptables -A TERMIX_OUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT \
    || return 1
  for ip in $gateway_ips; do
    iptables -A TERMIX_OUT -d "$ip" -j ACCEPT || return 1
  done
  iptables -A TERMIX_OUT -j REJECT --reject-with icmp-port-unreachable || return 1

  # Only now, once every accept is in place, is the chain worth entering.
  iptables -C OUTPUT -j TERMIX_OUT 2>/dev/null \
    || iptables -A OUTPUT -j TERMIX_OUT || return 1
}

if [[ "$VPN_STRICT_ROUTES" == "true" ]]; then
  if apply_strict_routes; then
    echo "[vpn-sidecar] anything outside the tunnel is refused"
  else
    echo "[vpn-sidecar] could not apply the strict route rules." >&2
    echo "[vpn-sidecar] NET_ADMIN and iptables are needed. To run without" >&2
    echo "[vpn-sidecar] them -- and accept that traffic outside the tunnel's" >&2
    echo "[vpn-sidecar] routes leaves by this container's own route -- set" >&2
    echo "[vpn-sidecar] VPN_STRICT_ROUTES=false." >&2
    exit 1
  fi
else
  echo "[vpn-sidecar] strict routes off: traffic outside the tunnel leaves by this container's route" >&2
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
