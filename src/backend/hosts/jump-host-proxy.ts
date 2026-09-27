/*
 * No longer on the connection path.
 *
 * The first jump hop is now reached through resolveHostGateway, which reads a
 * host's network profile as well as its own proxy -- this helper read only
 * the proxy, so a jump host inside a customer's network was dialled from the
 * server's own route. Kept because it is exported and tested; do not reach for
 * it when adding a path, since it will silently miss the profile.
 */

import type { ProxyNode } from "../../types/index.js";
import type { SOCKS5Config } from "../utils/socks5-helper.js";

type JumpHostProxyConfig = {
  useSocks5?: boolean | null;
  socks5Host?: string | null;
  socks5Port?: number | null;
  socks5Username?: string | null;
  socks5Password?: string | null;
  socks5ProxyChain?: ProxyNode[] | string | null;
};

function parseProxyChain(value: JumpHostProxyConfig["socks5ProxyChain"]) {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value !== "string" || value.length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as ProxyNode[]) : [];
  } catch {
    return [];
  }
}

export function getJumpHostSocks5Config(
  firstHop: JumpHostProxyConfig | null | undefined,
): SOCKS5Config | null {
  if (!firstHop?.useSocks5) {
    return null;
  }

  const socks5ProxyChain = parseProxyChain(firstHop.socks5ProxyChain);
  if (!firstHop.socks5Host && socks5ProxyChain.length === 0) {
    return null;
  }

  return {
    useSocks5: true,
    socks5Host: firstHop.socks5Host ?? undefined,
    socks5Port: firstHop.socks5Port ?? undefined,
    socks5Username: firstHop.socks5Username ?? undefined,
    socks5Password: firstHop.socks5Password ?? undefined,
    socks5ProxyChain,
  };
}
