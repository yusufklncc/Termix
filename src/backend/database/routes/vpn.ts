import express, { type Response } from "express";
import { createCurrentVpnProfileRepository } from "../repositories/factory.js";
import type { VpnProfileRecord } from "../repositories/vpn-profile-repository.js";
import type { AuthenticatedRequest } from "../../../types/index.js";
import { authLogger } from "../../utils/logger.js";
import { AuthManager } from "../../utils/auth-manager.js";
import { findVpnProfileError } from "./vpn-validation.js";
import {
  dropManagedNetwork,
  managedDoorPort,
  raiseManagedNetwork,
  resolveNetManagerOptions,
} from "../../utils/net-manager-client.js";

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

/** Never let a secret back out; say only whether one is set. */
function toResponse(profile: VpnProfileRecord) {
  const { gatewayPassword, authPassword, extraConfig, ...rest } =
    profile as VpnProfileRecord & {
      authPassword?: string | null;
      extraConfig?: string | null;
    };
  return {
    ...rest,
    hasGatewayPassword: !!gatewayPassword,
    hasAuthPassword: !!authPassword,
    hasExtraConfig: !!extraConfig,
  };
}

/** The fields a managed profile carries, kept together so adding one reaches
 * both routes rather than whichever was remembered. */
function managedFieldsFrom(body: Record<string, unknown>) {
  return {
    provider: (body.provider as string) ?? null,
    serverHost: (body.serverHost as string) ?? null,
    serverPort: body.serverPort == null ? null : Number(body.serverPort),
    authUsername: (body.authUsername as string) ?? null,
    authPassword: (body.authPassword as string) ?? null,
    trustedFingerprint: (body.trustedFingerprint as string) ?? null,
    extraConfig: (body.extraConfig as string) ?? null,
  };
}

/**
 * Hand a managed profile to the manager and record what came back.
 *
 * A network that will not come up is still saved: hosts can be put on it, and
 * they will refuse to connect with the reason the resolver already gives.
 * Refusing the save instead would lose the configuration over a gateway that
 * happens to be down.
 */
async function raiseAndRecord(
  profile: VpnProfileRecord & Record<string, unknown>,
): Promise<VpnProfileRecord> {
  const result = await raiseManagedNetwork(
    {
      id: profile.id,
      provider: profile.provider,
      serverHost: profile.serverHost,
      serverPort: profile.serverPort ?? 443,
      trustedFingerprint: profile.trustedFingerprint,
    },
    {
      username: profile.authUsername,
      password: profile.authPassword,
      extra: profile.extraConfig,
    },
  );

  const repository = createCurrentVpnProfileRepository();
  const updated = await repository.updateById(profile.id, profile.userId, {
    lastState: result.state,
    lastError: result.error ?? null,
  } as never);
  return updated ?? profile;
}

router.get("/profiles", authenticateJWT, async (req, res: Response) => {
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

router.post("/profiles", authenticateJWT, async (req, res: Response) => {
  const userId = (req as AuthenticatedRequest).userId;
  const invalid = findVpnProfileError(req.body);
  if (invalid) return res.status(400).json({ error: invalid });

  try {
    const kind = String(req.body.kind ?? "declared");
    const managed = kind === "managed";
    const manager = resolveNetManagerOptions();

    if (managed && !manager) {
      return res.status(400).json({
        error:
          "No network manager is configured, so Termix cannot raise a tunnel itself",
      });
    }

    const repository = createCurrentVpnProfileRepository();
    let created = await repository.create({
      userId,
      name: String(req.body.name).trim(),
      description: req.body.description ?? null,
      folder: req.body.folder ?? null,
      tags: req.body.tags ?? null,
      kind,
      gatewayType: req.body.gatewayType ?? "socks5",
      // A managed profile's address is the manager's, on a port worked out
      // from the id -- which only exists once the row does, so it is written
      // back below rather than guessed here.
      gatewayHost: managed
        ? manager!.host
        : String(req.body.gatewayHost).trim(),
      gatewayPort: managed ? 1 : Number(req.body.gatewayPort),
      gatewayUsername: managed ? null : (req.body.gatewayUsername ?? null),
      gatewayPassword: managed ? null : (req.body.gatewayPassword ?? null),
      ...(managed ? managedFieldsFrom(req.body) : {}),
    });

    if (managed) {
      created =
        (await repository.updateById(created.id, userId, {
          gatewayPort: managedDoorPort(created.id),
        })) ?? created;
      created = await raiseAndRecord(created as never);
    }

    res.status(201).json(toResponse(created));
  } catch (error) {
    authLogger.error("Failed to create VPN profile", error, {
      operation: "vpn_profile_create",
      userId,
    });
    res.status(500).json({ error: "Failed to create the network profile" });
  }
});

router.put("/profiles/:id", authenticateJWT, async (req, res: Response) => {
  const userId = (req as AuthenticatedRequest).userId;
  const id = Number.parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "Invalid profile id" });
  }

  try {
    const repository = createCurrentVpnProfileRepository();
    const existing = await repository.findById(id, userId);
    // A profile belonging to someone else is reported as absent rather than
    // forbidden: whether it exists is not this user's business either. The
    // lookup is scoped to the owner, so it is already absent here.
    if (!existing) {
      return res.status(404).json({ error: "Network profile not found" });
    }

    const merged = { ...existing, ...req.body };
    const invalid = findVpnProfileError(merged);
    if (invalid) return res.status(400).json({ error: invalid });

    // The kind is fixed at creation: a declared profile has an address the
    // operator gave, a managed one has a tunnel Termix raised, and turning one
    // into the other mid-life is a different operation than editing it.
    const managed = String(existing.kind) === "managed";

    let updated = await repository.updateById(id, userId, {
      name: String(merged.name).trim(),
      description: merged.description ?? null,
      folder: merged.folder ?? null,
      tags: merged.tags ?? null,
      gatewayType: merged.gatewayType ?? "socks5",
      gatewayHost: managed
        ? existing.gatewayHost
        : String(merged.gatewayHost).trim(),
      gatewayPort: managed ? existing.gatewayPort : Number(merged.gatewayPort),
      gatewayUsername: managed ? null : (merged.gatewayUsername ?? null),
      // Absent means "leave the stored secret alone"; empty means "clear it".
      ...(req.body.gatewayPassword === undefined || managed
        ? {}
        : { gatewayPassword: req.body.gatewayPassword || null }),
      ...(managed
        ? {
            ...managedFieldsFrom(merged as Record<string, unknown>),
            ...(req.body.authPassword === undefined
              ? { authPassword: existing.authPassword }
              : { authPassword: req.body.authPassword || null }),
          }
        : {}),
    });

    // An edited tunnel is raised again: the server, the account or the pin may
    // be what changed, and the one that is running was built from the old ones.
    // This is also the only thing that clears a refusal -- the sync leaves
    // those alone, because retrying a password the gateway rejected locks the
    // account rather than getting in.
    // A switched-off network stays down when it is edited. The operator took
    // it down deliberately; saving a name should not put it back.
    if (managed && updated && updated.enabled !== false) {
      updated = await raiseAndRecord(updated as never);
    }

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

/**
 * Switched on or off by hand.
 *
 * A tunnel that is up is a live path from this server into someone else's
 * network, used or not. Taking one down should not mean deleting the profile
 * and re-entering its credentials, and the sync must not undo the decision --
 * which is why this is stored rather than just acted on.
 */
router.put(
  "/profiles/:id/enabled",
  authenticateJWT,
  async (req, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const id = Number.parseInt(String(req.params.id), 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "Invalid profile id" });
    }
    if (typeof req.body?.enabled !== "boolean") {
      return res.status(400).json({ error: "enabled must be true or false" });
    }

    try {
      const repository = createCurrentVpnProfileRepository();
      const existing = await repository.findById(id, userId);
      if (!existing) {
        return res.status(404).json({ error: "Network profile not found" });
      }
      if (String(existing.kind) !== "managed") {
        // A declared tunnel is the operator's to run; Termix switching it would
        // be a promise it cannot keep.
        return res.status(400).json({
          error: "Only a network Termix raises can be switched from here",
        });
      }

      const enabled = req.body.enabled as boolean;
      let updated = await repository.updateById(id, userId, {
        enabled,
        ...(enabled ? {} : { lastState: "off", lastError: null }),
      } as never);

      if (!updated)
        return res.status(404).json({ error: "Network profile not found" });

      if (enabled) {
        updated = await raiseAndRecord(updated as never);
      } else {
        await dropManagedNetwork(id);
      }

      res.json(toResponse(updated));
    } catch (error) {
      authLogger.error("Failed to switch a VPN profile", error, {
        operation: "vpn_profile_switch",
        userId,
        profileId: id,
      });
      res.status(500).json({ error: "Failed to switch the network" });
    }
  },
);

router.delete("/profiles/:id", authenticateJWT, async (req, res: Response) => {
  const userId = (req as AuthenticatedRequest).userId;
  const id = Number.parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "Invalid profile id" });
  }

  try {
    const repository = createCurrentVpnProfileRepository();
    const existing = await repository.findById(id, userId);
    if (!existing) {
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

    // The tunnel goes before the row does. Leaving it up would keep a
    // namespace and a VPN session alive for a profile nothing points at.
    if (String(existing.kind) === "managed") {
      await dropManagedNetwork(id);
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
