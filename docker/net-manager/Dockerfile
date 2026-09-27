# One container, many networks.
#
# Phase 8's sidecar put each network in its own container, because two
# corporate VPNs cannot share a network namespace: both push a default route,
# and customer subnets overlap. That is still true -- but a namespace is
# cheaper than a container, and the operator should not edit compose to gain a
# customer. So this holds one namespace per network instead.
#
# It is the only part that needs privileges, and it is never published: Termix
# reaches it on the internal network, the way it already reaches the RDP
# bridge.
# Trixie, not bookworm, for openconnect 9.12.
#
# Bookworm carries 9.01, which this fork's own Fortinet gateway rejects at the
# second form with "user input required in non-interactive mode" -- the same
# account and password that 9.12 signs in with. Phase 8's sidecar is on trixie
# and works; this had no business being older than it.
FROM node:22-trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      openconnect vpnc-scripts microsocks iproute2 iptables ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY manager.js /app/manager.js
COPY vpnc-script-no-dns /app/vpnc-script-no-dns
RUN chmod +x /app/vpnc-script-no-dns

# The control channel. Termix only; do not publish it.
EXPOSE 3392

ENTRYPOINT ["node", "/app/manager.js"]
