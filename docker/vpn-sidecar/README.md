# VPN sidecar

A reference sidecar for reaching hosts that only exist inside a corporate VPN.

Termix does not dial the VPN itself. The tunnel runs in its own container, and
Termix is told only the address that container accepts traffic on. A network
profile records that address; every host assigned to the profile has its
connection carried through it.

This example speaks **Fortinet SSL-VPN**, via `openfortivpn`. The same shape
works for any client that can own a container's network namespace — swap the
`openfortivpn` call in `entrypoint.sh` for `wg-quick`, `openvpn` or
`openconnect` and leave the rest alone.

## Why one container per network

Two VPNs cannot share a namespace. Both push a default route, and customer
subnets overlap — two clients each using `192.168.1.0/24` is the normal case,
not the exception. So each network gets its own sidecar.

This is what makes overlapping subnets work at all: Termix never decides where
`192.168.1.50` is. It hands the address to the doorway belonging to that host's
profile, and the address is resolved inside _that_ namespace. Two hosts can
carry the identical address and land on different machines.

## What the sidecar is made of

- `openfortivpn` — the tunnel. The real thing, not an approximation of it.
- `microsocks` — the doorway. Not a substitute for the VPN: it is how traffic
  from outside enters the namespace the tunnel lives in.

## The doorway must never outlive the tunnel

If the tunnel dropped and the doorway kept listening, Termix would still be
handed connections — and they would leave by the container's own route instead
of the VPN. Silently, for a host configured precisely to avoid that.

So the tunnel is the container's life. `entrypoint.sh` opens the doorway only
after `ppp0` is up, and exits as soon as either one ends. While the container is
down, sessions for that network fail to connect. That is the intended
behaviour, not a bug to paper over.

## Setup

1. Copy `compose.example.yml` into your own compose file and fill in the
   environment. One service per network. The image is published as
   `yusufklncc/termix-vpn-sidecar:latest`, so a deployed server needs no
   source checkout; `build: ./vpn-sidecar` works from one.
2. `cap_add: NET_ADMIN` and `devices: /dev/ppp` are required — ppp needs both.
   If `/dev/ppp` is missing on the host, load the module: `modprobe ppp_generic`.
3. Do **not** publish port 1080. The doorway should be reachable only from
   Termix's own Docker network.
4. In Termix's host editor, open **Manage networks** and add a profile whose
   **Gateway address** is the sidecar's service name and whose **Gateway port**
   is 1080. Then set that profile as the **Network** of the hosts inside it.

### Environment

| Variable           | Required  | Meaning                                                     |
| ------------------ | --------- | ----------------------------------------------------------- |
| `VPN_HOST`         | yes       | FortiGate address                                           |
| `VPN_PORT`         | no (443)  | FortiGate port                                              |
| `VPN_USER`         | yes       | VPN account                                                 |
| `VPN_PASSWORD`     | yes       | VPN password                                                |
| `VPN_TRUSTED_CERT` | no        | Gateway certificate digest, when it is not publicly trusted |
| `VPN_OTP`          | no        | One-time code, where the gateway asks for one               |
| `SOCKS_PORT`       | no (1080) | Port the doorway listens on                                 |

A gateway that enforces SAML or FortiClient EMS will not accept
`openfortivpn`. That is a policy on the gateway, not something a client can
work around.

## Checking it

Once the sidecar is up, `docker logs` should show `ppp0 is up` followed by
`doorway listening`. If it shows the first without the second, the doorway
failed; if it shows neither, the tunnel did.

Then connect to a host through the profile. To confirm it is really going
through the tunnel, point a host at an address that exists **only** inside the
VPN — if it connects, the traffic went where it was supposed to.
