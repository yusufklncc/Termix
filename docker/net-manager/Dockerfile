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
# Tailscale's own binaries: Debian does not carry them, and they are static,
# so they are copied rather than installed.
FROM tailscale/tailscale:latest AS tailscale

# Netbird's client, built here rather than copied out of their image.
#
# 0.79.0 until 2026-10-19, then 0.81.2. The version moved for its Go, and then
# the build moved here for the same reason: a release is built once and the Go
# it was built with ages from that day, so every stdlib CVE published
# afterwards waits for upstream to cut a release. 0.81.2's own binary carries
# go1.26.7 and half this image's findings with it.
#
# Only the dependencies are left exactly as the tag pins them. This is the VPN
# data path -- x/net, grpc, gopacket, pion/dtls are the packet handling
# itself -- and a toolchain is a safer thing to move than those are. opkssh,
# an auth helper, had its modules moved; this one does not.
#
# The build is upstream's own, from the comment at the top of their
# client/Dockerfile, with goreleaser's tag and version ldflag.
FROM golang:1.27.2 AS netbird
ARG TARGETARCH
ARG NETBIRD_VERSION=0.81.2
WORKDIR /src

RUN git clone --depth 1 --branch "v$NETBIRD_VERSION" \
      https://github.com/netbirdio/netbird.git .

# GOTOOLCHAIN=local, or go.mod's own toolchain directive fetches go1.26.7 and
# builds with it -- the Go this stage exists to leave behind.
RUN GOTOOLCHAIN=local CGO_ENABLED=0 GOOS=linux GOARCH="$TARGETARCH" \
      go build -trimpath -tags load_wgnt_from_rsrc \
        -ldflags "-s -w -X github.com/netbirdio/netbird/version.version=$NETBIRD_VERSION" \
        -o /usr/local/bin/netbird ./client

FROM node:22-trixie-slim

# upgrade for the same reason as the application image: the base carries the
# findings and is rebuilt on its own schedule. npm goes with it -- the
# entrypoint is node, nothing here shells out to npm, and npm's own vendored
# tree is where this image's pacote, sigstore, ip-address and brace-expansion
# reports come from.
RUN apt-get update && apt-get -y upgrade \
 && apt-get install -y --no-install-recommends \
      openconnect vpnc-scripts microsocks iproute2 iptables ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
      /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY --from=tailscale /usr/local/bin/tailscaled /usr/local/bin/tailscaled
COPY --from=tailscale /usr/local/bin/tailscale /usr/local/bin/tailscale
COPY --from=netbird /usr/local/bin/netbird /usr/local/bin/netbird

COPY manager.js /app/manager.js
COPY certificate-complaint.js /app/certificate-complaint.js
COPY vpnc-script-no-dns /app/vpnc-script-no-dns
RUN chmod +x /app/vpnc-script-no-dns

# The control channel. Termix only; do not publish it.
EXPOSE 3392

ENTRYPOINT ["node", "/app/manager.js"]
