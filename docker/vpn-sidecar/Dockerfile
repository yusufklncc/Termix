# One network, one container.
#
# Two corporate VPNs cannot share a network namespace: both push a default
# route, and customer subnets overlap. So each network gets its own sidecar,
# and Termix is told only the address this one accepts traffic on.
#
# The tunnel is real FortiClient SSL-VPN, spoken by openfortivpn. microsocks is
# not a substitute for it -- it is the doorway Termix hands traffic to in order
# to enter the namespace the tunnel lives in.
FROM debian:trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      openfortivpn microsocks ppp iproute2 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# The doorway. Do not publish this to the host: only Termix, on the same Docker
# network, has any business reaching it.
EXPOSE 1080

ENTRYPOINT ["/entrypoint.sh"]
