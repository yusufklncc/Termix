import type { Router } from "express";
import type { PluginContext } from "@termix/plugin-sdk/backend";
import { createGatewayService } from "./gateway.js";
import { setNetManagerLogger } from "./net-manager-client.js";
import { VpnProfileRepository } from "./repository.js";
import { registerVpnRoutes } from "./routes.js";

/**
 * The networks hosts are reached through.
 *
 * A host marked with one leaves through its tunnel and never by this
 * server's own route -- that is the whole point of the field, so a refusal
 * here fails the session rather than falling back.
 *
 * The tunnels themselves are raised by a helper container, which this talks
 * to over a framed channel; nothing in this process carries the traffic.
 */
export async function activate(ctx: PluginContext) {
  setNetManagerLogger({
    warn: (message) => ctx.log.warn(message),
    error: (message) => ctx.log.error(message),
  });

  const repository = new VpnProfileRepository(ctx);

  /*
   * Core asks this when it works out how to reach a host. It is the one hook
   * that has to stay in core: everything else about a VPN -- the profiles,
   * the manager, the panel -- lives here.
   */
  ctx.services.provide("host.gateway", createGatewayService(ctx, repository));

  registerVpnRoutes(ctx.http.router<Router>(), ctx, repository);

  ctx.log.info("VPNs mounted at /plugin-api/vpn");
}

export async function deactivate() {
  // Everything is registered through ctx, which core disposes.
}
