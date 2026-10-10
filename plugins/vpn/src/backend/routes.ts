import type { Request, Response, Router } from "express";
import type { PluginContext } from "@termix/plugin-sdk/backend";
import {
  disconnectManagedNetwork,
  dropManagedNetwork,
  listManagedNetworks,
  managedDoorPort,
  raiseManagedNetwork,
  resolveNetManagerOptions,
} from "./net-manager-client.js";
import {
  assertSecretsReadable,
  UnreadableCredentialsError,
} from "./legacy-secrets.js";
import type { VpnProfileRecord, VpnProfileRepository } from "./repository.js";
import { findVpnProfileError } from "./validation.js";

const HOST_SETTING = "profileId";

/** What a profile looks like on the way out: secrets reported, never sent. */
function toResponse(profile: VpnProfileRecord) {
  const { gatewayPassword, authPassword, extraConfig, ...rest } = profile;
  return {
    ...rest,
    hasGatewayPassword: !!gatewayPassword,
    hasAuthPassword: !!authPassword,
    hasExtraConfig: !!extraConfig,
  };
}

/** The fields a managed profile carries, kept together so adding one reaches
 * both create and update. */
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

export function registerVpnRoutes(
  router: Router,
  ctx: PluginContext,
  repository: VpnProfileRepository,
): void {
  const actor = () => ctx.currentActor() as string;

  /**
   * Hand a managed profile to the manager and record what came back.
   *
   * A network that will not come up is still saved: hosts can be put on it,
   * and they refuse to connect with the reason the resolver gives. Refusing
   * the save would lose the configuration over a gateway that happens to be
   * down.
   */
  async function raiseAndRecord(
    profile: VpnProfileRecord,
  ): Promise<VpnProfileRecord> {
    // A credential nothing can read is not worth an attempt the gateway
    // counts. The refusal says what to do instead.
    assertSecretsReadable(profile);

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

    const updated = await repository.updateById(profile.id, profile.userId, {
      lastState: result.state,
      lastError: result.error ?? null,
    });
    return updated ?? profile;
  }

  /** How many hosts still name this profile. */
  async function hostsUsing(id: number): Promise<number> {
    const values = await ctx.settings.listHostValues<number>(HOST_SETTING);
    return values.filter((entry) => Number(entry.value) === id).length;
  }

  router.get("/profiles", async (_req: Request, res: Response) => {
    try {
      const rows = await repository.list(actor());
      // The stored state is what the manager last said; the live one is what
      // it says now, and a manager restart makes them differ.
      const live = await listManagedNetworks();
      const byId = new Map((live ?? []).map((n) => [Number(n.id), n]));
      res.json(
        rows.map((row) => {
          const now = byId.get(row.id);
          return {
            ...toResponse(row),
            ...(now ? { lastState: now.state, lastError: now.error } : {}),
          };
        }),
      );
    } catch (error) {
      ctx.log.error(`Failed to list VPN profiles: ${String(error)}`);
      res.status(500).json({ error: "Failed to list network profiles" });
    }
  });

  router.post("/profiles", async (req: Request, res: Response) => {
    const invalid = findVpnProfileError(req.body);
    if (invalid) return res.status(400).json({ error: invalid });

    try {
      const kind = String(req.body.kind ?? "declared");
      const managed = kind === "managed";
      const manager = resolveNetManagerOptions();
      if (managed && !manager) {
        return res.status(400).json({
          error:
            "No VPN manager is configured, so Termix cannot raise a tunnel itself",
        });
      }

      let created = await repository.create({
        userId: actor(),
        name: String(req.body.name).trim(),
        description: req.body.description ?? null,
        folder: req.body.folder ?? null,
        tags: req.body.tags ?? null,
        kind,
        gatewayType: req.body.gatewayType ?? "socks5",
        // A managed profile's address is the manager's, on a port worked out
        // from the id -- which only exists once the row does.
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
          (await repository.updateById(created.id, created.userId, {
            gatewayPort: managedDoorPort(created.id),
          })) ?? created;
        created = await raiseAndRecord(created);
      }

      res.status(201).json(toResponse(created));
    } catch (error) {
      ctx.log.error(`Failed to create a VPN profile: ${String(error)}`);
      if (error instanceof UnreadableCredentialsError) {
        return res.status(409).json({ error: error.message });
      }
      res.status(500).json({ error: "Failed to create the network profile" });
    }
  });

  router.put("/profiles/:id", async (req: Request, res: Response) => {
    const id = Number.parseInt(String(req.params.id), 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "Invalid profile id" });
    }

    try {
      const existing = await repository.findById(id, actor());
      // Someone else's profile is reported absent rather than forbidden:
      // whether it exists is not this user's business either.
      if (!existing) return res.status(404).json({ error: "VPN not found" });

      const merged = { ...existing, ...req.body };
      const invalid = findVpnProfileError(merged);
      if (invalid) return res.status(400).json({ error: invalid });

      const managed = String(existing.kind) === "managed";
      let updated = await repository.updateById(id, actor(), {
        name: String(merged.name).trim(),
        description: merged.description ?? null,
        folder: merged.folder ?? null,
        tags: merged.tags ?? null,
        ...(managed
          ? managedFieldsFrom(merged)
          : {
              gatewayType: merged.gatewayType ?? "socks5",
              gatewayHost: String(merged.gatewayHost).trim(),
              gatewayPort: Number(merged.gatewayPort),
              gatewayUsername: merged.gatewayUsername ?? null,
              gatewayPassword: merged.gatewayPassword ?? null,
            }),
      });
      if (!updated) return res.status(404).json({ error: "VPN not found" });

      // Edited: the server, the account or the pin may be what changed, so
      // what is running was built from the old ones.
      if (managed) updated = await raiseAndRecord(updated);

      res.json(toResponse(updated));
    } catch (error) {
      ctx.log.error(`Failed to update a VPN profile: ${String(error)}`);
      if (error instanceof UnreadableCredentialsError) {
        return res.status(409).json({ error: error.message });
      }
      res.status(500).json({ error: "Failed to update the network profile" });
    }
  });

  router.put("/profiles/:id/enabled", async (req: Request, res: Response) => {
    const id = Number.parseInt(String(req.params.id), 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "Invalid profile id" });
    }
    if (typeof req.body?.enabled !== "boolean") {
      return res.status(400).json({ error: "enabled must be true or false" });
    }

    try {
      const existing = await repository.findById(id, actor());
      if (!existing) return res.status(404).json({ error: "VPN not found" });
      if (String(existing.kind) !== "managed") {
        // A declared tunnel is the operator's to run; Termix switching it
        // would be a promise it cannot keep.
        return res.status(400).json({
          error: "Only a network Termix raises can be switched from here",
        });
      }

      const enabled = req.body.enabled as boolean;
      let updated = await repository.updateById(id, actor(), {
        enabled,
        ...(enabled ? {} : { lastState: "off", lastError: null }),
      });
      if (!updated) return res.status(404).json({ error: "VPN not found" });

      updated = enabled
        ? await raiseAndRecord(updated)
        : ((await dropManagedNetwork(id), updated) as VpnProfileRecord);

      res.json(toResponse(updated));
    } catch (error) {
      ctx.log.error(`Failed to switch a VPN profile: ${String(error)}`);
      if (error instanceof UnreadableCredentialsError) {
        return res.status(409).json({ error: error.message });
      }
      res.status(500).json({ error: "Failed to switch the network" });
    }
  });

  router.post(
    "/profiles/:id/disconnect",
    async (req: Request, res: Response) => {
      const id = Number.parseInt(String(req.params.id), 10);
      if (!Number.isInteger(id)) {
        return res.status(400).json({ error: "Invalid profile id" });
      }

      try {
        const existing = await repository.findById(id, actor());
        if (!existing) return res.status(404).json({ error: "VPN not found" });
        if (String(existing.kind) !== "managed") {
          return res.status(400).json({
            error: "Only a VPN Termix raises can be taken down from here",
          });
        }

        const result = await disconnectManagedNetwork(id);
        const updated = await repository.updateById(id, actor(), {
          lastState: result.state,
          lastError: null,
        });
        res.json(toResponse(updated ?? existing));
      } catch (error) {
        ctx.log.error(`Failed to disconnect a VPN: ${String(error)}`);
        res.status(500).json({ error: "Failed to take the network down" });
      }
    },
  );

  router.delete("/profiles/:id", async (req: Request, res: Response) => {
    const id = Number.parseInt(String(req.params.id), 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "Invalid profile id" });
    }

    try {
      const existing = await repository.findById(id, actor());
      if (!existing) return res.status(404).json({ error: "VPN not found" });

      /*
       * Refused while hosts still use it.
       *
       * Deleting would leave those hosts with no profile, and a host with no
       * profile connects directly -- out of the server's own route, which is
       * the one thing a host pointed at someone else's network must never do.
       */
      const inUse = await hostsUsing(id);
      if (inUse > 0) {
        return res.status(409).json({
          error: `This profile is still used by ${inUse} host${
            inUse === 1 ? "" : "s"
          }. Move them to another profile first.`,
          hostsUsing: inUse,
        });
      }

      if (String(existing.kind) === "managed") await dropManagedNetwork(id);
      await repository.deleteById(id, actor());
      res.json({ ok: true });
    } catch (error) {
      ctx.log.error(`Failed to delete a VPN profile: ${String(error)}`);
      res.status(500).json({ error: "Failed to delete the network profile" });
    }
  });
}
