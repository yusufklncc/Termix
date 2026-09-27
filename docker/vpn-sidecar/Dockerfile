# One network, one container.
#
# Two corporate VPNs cannot share a network namespace: both push a default
# route, and customer subnets overlap. So each network gets its own sidecar,
# and Termix is told only the address this one accepts traffic on.
#
# The tunnel is real FortiClient SSL-VPN. Two clients can speak it: openfortivpn
# (via pppd, needs /dev/ppp) and openconnect (via tun, needs /dev/net/tun).
# Which one is available decides more often than which one is better.
#
# microsocks is not a substitute for either -- it is the doorway Termix hands
# traffic to in order to enter the namespace the tunnel lives in.
FROM debian:trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      openfortivpn openconnect vpnc-scripts microsocks ppp iproute2 \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# The doorway. Do not publish this to the host: only Termix, on the same Docker
# network, has any business reaching it.
EXPOSE 1080

ENTRYPOINT ["/entrypoint.sh"]
