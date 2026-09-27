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

| Variable            | Required          | Meaning                                                                   |
| ------------------- | ----------------- | ------------------------------------------------------------------------- |
| `VPN_CLIENT`        | no (openfortivpn) | `openfortivpn` (needs `/dev/ppp`) or `openconnect` (needs `/dev/net/tun`) |
| `VPN_HOST`          | yes               | FortiGate address                                                         |
| `VPN_PORT`          | no (443)          | FortiGate port                                                            |
| `VPN_USER`          | yes               | VPN account                                                               |
| `VPN_PASSWORD`      | yes               | VPN password                                                              |
| `VPN_TRUSTED_CERT`  | no                | Gateway certificate digest, when it is not publicly trusted               |
| `VPN_TRUSTED_PIN`   | no                | The same idea for `openconnect`, which pins the public key instead        |
| `VPN_OTP`           | no                | One-time code, where the gateway asks for one                             |
| `SOCKS_PORT`        | no (1080)         | Port the doorway listens on                                               |
| `SOCKS_USER`        | see below         | Password-protects the doorway                                             |
| `SOCKS_PASSWORD`    | see below         | Set together with `SOCKS_USER`                                            |
| `VPN_STRICT_ROUTES` | no (true)         | Refuse anything the tunnel does not carry                                 |
| `VPN_AUTH_BACKOFF`  | no (900)          | Seconds to wait after the gateway refuses the credentials                 |

A doorway reachable only from Termix's own Docker network needs no password.
One reachable from anywhere else -- see below -- is a way into the VPN for
whoever finds the port, and must have one. Set it on the profile too, as
**Gateway username** and **Gateway password**.

A gateway that enforces SAML or FortiClient EMS will not accept
`openfortivpn`. That is a policy on the gateway, not something a client can
work around.

## When ppp is not available

`openfortivpn` needs pppd, and pppd needs `/dev/ppp` from the host kernel. A
container host that does not have it (`modinfo ppp_generic` fails) cannot run
this sidecar as-is. Unprivileged LXC is the common case: the kernel belongs to
the hypervisor, not to the container.

Three ways out, cheapest first:

- **Use `openconnect` instead.** It speaks the same FortiGate SSL-VPN over a
  tun device, so it never touches ppp. Set `VPN_CLIENT: openconnect` and give
  the container `/dev/net/tun` and `NET_ADMIN` instead of `/dev/ppp`.

  It pins differently: `VPN_TRUSTED_CERT` is the certificate's digest,
  `VPN_TRUSTED_PIN` is the public key's, base64 rather than hex. They are not
  interchangeable, and passing one where the other belongs looks exactly like
  reaching the wrong gateway. Get the pin with:

  ```bash
  openssl s_client -connect GATEWAY:443 -servername GATEWAY </dev/null 2>/dev/null \
    | openssl x509 -pubkey -noout | openssl pkey -pubin -outform DER \
    | openssl dgst -sha256 -binary | base64
  ```

- **Pass the device in.** On the hypervisor, `modprobe ppp_generic`, then give
  the container the device. On Proxmox, in `/etc/pve/lxc/<id>.conf`:

  ```
  lxc.cgroup2.devices.allow: c 108:0 rwm
  lxc.mount.entry: /dev/ppp dev/ppp none bind,create=file
  ```

- **Put the doorway somewhere else.** A profile's gateway is an address, not
  necessarily a sidecar next door. Run this container on a machine that does
  have ppp and point the profile at `that-machine:1080`. The doorway is then on
  the network rather than inside Docker, so give it `SOCKS_USER` and
  `SOCKS_PASSWORD` and do not expose the port any wider than it needs.

## Anything outside the tunnel is refused

A corporate VPN usually pushes **split routes**: some subnets go through it and
the rest do not. Without a rule to stop it, a host whose address falls outside
those routes still connects -- out of this container's own internet route,
quietly, for a host that was assigned to a network precisely so that would not
happen.

So by default the sidecar accepts outbound traffic only on the tunnel
interface, plus replies to whoever reached the doorway and the tunnel's own
carrier to the gateway. Everything else is rejected, which Termix reports as a
failed connection rather than succeeding by the wrong route.

Two consequences worth knowing:

- **Name resolution is subject to the same rule.** A target's name is resolved
  by the resolver in `/etc/resolv.conf`; if that is a public resolver reached
  outside the tunnel, the lookup is refused. Give targets as IP addresses, or
  as names the VPN's own DNS can answer.
- **It needs `NET_ADMIN` and iptables.** If the rules cannot be applied the
  container stops and says so, rather than starting without them. To run
  anyway -- accepting that traffic outside the tunnel's routes leaves by this
  container's route -- set `VPN_STRICT_ROUTES: "false"`.

## A refused password is not retried

A dropped tunnel is worth reconnecting. A refused password is not: trying it
again cannot succeed, and a FortiGate counts the attempts. With a restart
policy and no wait, that is nine login attempts a minute -- measured -- which
locks the account and then keeps it locked, so waiting for the lockout to
lapse never helps.

So a refusal waits `VPN_AUTH_BACKOFF` seconds before the container exits and
the restart policy tries again. Fix the credentials and restart the container
to try at once.

## Checking it

Once the sidecar is up, `docker logs` should show `ppp0 is up` followed by
`doorway listening`. If it shows the first without the second, the doorway
failed; if it shows neither, the tunnel did.

Then connect to a host through the profile. To confirm it is really going
through the tunnel, point a host at an address that exists **only** inside the
VPN — if it connects, the traffic went where it was supposed to.
