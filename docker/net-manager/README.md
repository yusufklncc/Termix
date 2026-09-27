# Network manager

One container, many networks — added to compose once, and never edited again
to gain a customer.

Phase 8's sidecar put each network in a container of its own, because two
corporate VPNs cannot share a network namespace: both push a default route,
and customer subnets overlap. That is still true. But a namespace is cheaper
than a container, so this holds one namespace per network and Termix drives it
from the UI.

## What Termix gets back

A network ends, as it did before, as **an address**: this container, on a port
computed from the profile's id (`20000 + id`). Everything downstream — the
resolver, the tunnels, the ownership check, the refusal when the doorway is
gone — is phase 8's and unchanged. The only new thing is who fills the address
in.

## Setup

```yaml
services:
  termix-netmgr:
    image: yusufklncc/termix-netmgr:latest
    cap_add: [NET_ADMIN, SYS_ADMIN]
    devices:
      - /dev/net/tun:/dev/net/tun
    environment:
      NET_MANAGER_TOKEN: a-long-random-secret
    networks: [termix]
    restart: unless-stopped
    # No ports: Termix reaches it on the internal network, and nothing else
    # should.
```

Termix is given the same secret as `NET_MANAGER_TOKEN` and reaches the
manager at `NET_MANAGER_URL` (default `termix-netmgr:3392`).

| Variable                | Required     | Meaning                                                 |
| ----------------------- | ------------ | ------------------------------------------------------- |
| `NET_MANAGER_TOKEN`     | yes          | Shared secret; the manager refuses to start without one |
| `NET_MANAGER_PORT`      | no (3392)    | Control port                                            |
| `NET_MANAGER_BIND`      | no (0.0.0.0) | Control bind address                                    |
| `NET_MANAGER_DOOR_BASE` | no (20000)   | A profile's doorway is this plus its id                 |
| `NET_MANAGER_SUBNET`    | no (10.88)   | The /16 the namespaces are addressed from               |

If IPv4 forwarding is off, a namespace cannot reach its gateway; the manager
says so and names the `sysctls` entry to add. It is on by default under
Docker.

## The secret is also the key

The control channel carries VPN passwords, which the RDP bridge's never did.
The token proves who is speaking **and** is the key the credentials travel
under: they are sealed with AES-GCM under a key derived from it. A Docker
bridge network keeps containers apart, but one with `NET_RAW` on the same
network can listen, and a VPN password is not something to hand it.

Credentials are never written to disk. They are held in memory and given to
the VPN client on stdin; after a restart Termix sends them again.

## Inside

Per network: a namespace `tx<id>`, a veth pair addressed from `10.88.0.0/16`,
the VPN client and a SOCKS doorway inside it, and a forwarder out here that
carries connections in. The namespace reaches its gateway through this
container's own route, NAT'd; once the tunnel is up, everything the tunnel
does not carry is refused, the same rule the phase 8 sidecar applies.

The doorway never outlives the tunnel: when the VPN client exits, the doorway
closes, so Termix's next connection fails instead of leaving by this
container's route.

## Providers

`fortinet`, via openconnect. One on purpose — it is the gateway this can be
measured against. A second fits the same shape: a command, an interface name,
and what it wants on stdin.

## Alongside the sidecar

Phase 8's sidecar and this are not alternatives to choose between. A declared
profile still points at a sidecar the operator runs, a managed one is raised
here, and a Termix can have both — which is how an existing network keeps
working while a new one is made from the editor.
