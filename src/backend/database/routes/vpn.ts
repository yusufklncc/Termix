import express, { type Response } from "express";
import { createCurrentVpnProfileRepository } from "../repositories/factory.js";
import type { VpnProfileRecord } from "../repositories/vpn-profile-repository.js";
import type { AuthenticatedRequest } from "../../../types/index.js";
import { authLogger } from "../../utils/logger.js";
import { AuthManager } from "../../utils/auth-manager.js";
import { findVpnProfileError } from "./vpn-validation.js";

/**
 * Network profiles: the tunnels hosts are reached through.
 *
 * Phase 8 A2 -- the tunnel is run by the operator, one sidecar per VPN, and a
 * profile records where that sidecar's doorway is. Profiles belong to the user
 * who made them: a tunnel carries someone's access to someone else's network,
 * so it is not shared implicitly.
 */

const router = express.Router();
const authManager = AuthManager.getInstance();
const authenticateJWT = authManager.createAuthMiddleware();

/** Never let the gateway secret back out; say only whether one is set. */
function toResponse(profile: VpnProfileRecord) {
  const { gatewayPassword, ...rest } = profile;
  return { ...rest, hasGatewayPassword: !!gatewayPassword };
}

router.get("/", authenticateJWT, async (req, res: Response) => {
  const userId = (req as AuthenticatedRequest).userId;
  try {
    const profiles =
      await createCurrentVpnProfileRepository().listByUser(userId);
    res.json(profiles.map(toResponse));
  } catch (error) {
    authLogger.error("Failed to list VPN profiles", error, {
      operation: "vpn_profile_list",
      userId,
    });
    res.status(500).json({ error: "Failed to list network profiles" });
  }
});

router.post("/", authenticateJWT, async (req, res: Response) => {
  const userId = (req as AuthenticatedRequest).userId;
  const invalid = findVpnProfileError(req.body);
  if (invalid) return res.status(400).json({ error: invalid });

  try {
    const created = await createCurrentVpnProfileRepository().create({
      userId,
      name: String(req.body.name).trim(),
      description: req.body.description ?? null,
      folder: req.body.folder ?? null,
      tags: req.body.tags ?? null,
      kind: req.body.kind ?? "declared",
      gatewayType: req.body.gatewayType ?? "socks5",
      gatewayHost: String(req.body.gatewayHost).trim(),
      gatewayPort: Number(req.body.gatewayPort),
      gatewayUsername: req.body.gatewayUsername ?? null,
      gatewayPassword: req.body.gatewayPassword ?? null,
    });
    res.status(201).json(toResponse(created));
  } catch (error) {
    authLogger.error("Failed to create VPN profile", error, {
      operation: "vpn_profile_create",
      userId,
    });
    res.status(500).json({ error: "Failed to create the network profile" });
  }
});

router.put("/:id", authenticateJWT, async (req, res: Response) => {
  const userId = (req as AuthenticatedRequest).userId;
  const id = Number.parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "Invalid profile id" });
  }

  try {
    const repository = createCurrentVpnProfileRepository();
    const existing = await repository.findById(id);
    // A profile belonging to someone else is reported as absent rather than
    // forbidden: whether it exists is not this user's business either.
    if (!existing || existing.userId !== userId) {
      return res.status(404).json({ error: "Network profile not found" });
    }

    const merged = { ...existing, ...req.body };
    const invalid = findVpnProfileError(merged);
    if (invalid) return res.status(400).json({ error: invalid });

    const updated = await repository.updateById(id, userId, {
      name: String(merged.name).trim(),
      description: merged.description ?? null,
      folder: merged.folder ?? null,
      tags: merged.tags ?? null,
      gatewayType: merged.gatewayType ?? "socks5",
      gatewayHost: String(merged.gatewayHost).trim(),
      gatewayPort: Number(merged.gatewayPort),
      gatewayUsername: merged.gatewayUsername ?? null,
      // Absent means "leave the stored secret alone"; empty means "clear it".
      ...(req.body.gatewayPassword === undefined
        ? {}
        : { gatewayPassword: req.body.gatewayPassword || null }),
    });

    res.json(updated ? toResponse(updated) : { error: "Not found" });
  } catch (error) {
    authLogger.error("Failed to update VPN profile", error, {
      operation: "vpn_profile_update",
      userId,
      profileId: id,
    });
    res.status(500).json({ error: "Failed to update the network profile" });
  }
});

router.delete("/:id", authenticateJWT, async (req, res: Response) => {
  const userId = (req as AuthenticatedRequest).userId;
  const id = Number.parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "Invalid profile id" });
  }

  try {
    const repository = createCurrentVpnProfileRepository();
    const existing = await repository.findById(id);
    if (!existing || existing.userId !== userId) {
      return res.status(404).json({ error: "Network profile not found" });
    }

    /*
     * Refused while hosts still use it.
     *
     * The column is ON DELETE SET NULL, so deleting would quietly detach them
     * -- and a host with no profile connects directly, out of the server's own
     * route, which is the one thing a host pointed at someone else's network
     * must never do. The foreign key stays permissive as a last resort; this
     * is where the decision is made.
     */
    const inUse = await repository.countHostsUsing(id);
    if (inUse > 0) {
      return res.status(409).json({
        error: `This profile is still used by ${inUse} host${inUse === 1 ? "" : "s"}. Move them to another profile first.`,
        hostsUsing: inUse,
      });
    }

    await repository.deleteById(id);
    res.json({ message: "Network profile deleted" });
  } catch (error) {
    authLogger.error("Failed to delete VPN profile", error, {
      operation: "vpn_profile_delete",
      userId,
      profileId: id,
    });
    res.status(500).json({ error: "Failed to delete the network profile" });
  }
});

export default router;
