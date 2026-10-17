import type { Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { createGatewayService } from "./gateway.js";
import { setNetManagerLogger } from "./net-manager-client.js";
import { VpnProfileRepository } from "./repository.js";
import { registerVpnRoutes } from "./routes.js";
import { startManagedNetworkSync, stopManagedNetworkSync } from "./sync.js";

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

  /*
   * Puts the managed tunnels back after a restart -- of Termix or of the
   * manager, which holds its networks in memory. Does nothing where no
   * manager is configured.
   */
  startManagedNetworkSync(repository, ctx.log);
  ctx.disposables.add(() => stopManagedNetworkSync());

  ctx.log.info("VPNs mounted at /plugin-api/vpn");
}

export async function deactivate() {
  // Everything is registered through ctx, which core disposes.
}
