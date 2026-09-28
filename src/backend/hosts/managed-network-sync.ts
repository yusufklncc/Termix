import { createCurrentVpnProfileRepository } from "../database/repositories/factory.js";
import type { VpnProfileRecord } from "../database/repositories/vpn-profile-repository.js";
import {
  listManagedNetworks,
  raiseManagedNetwork,
  resolveNetManagerOptions,
} from "../utils/net-manager-client.js";
import { sshLogger } from "../utils/logger.js";
import { getErrorMessage } from "../utils/error-message.js";

/**
 * Making sure every VPN has a doorway.
 *
 * The manager holds its VPNs in memory, so a restart of it -- or of Termix --
 * leaves profiles pointing at an address nothing listens on. Hosts on them
 * then refuse to connect, correctly but unhelpfully, until someone opens the
 * profile and saves it again.
 *
 * This registers them instead. Registering opens a doorway; it does not dial
 * the gateway, so putting a VPN back costs nothing and takes no login
 * attempt.
 */

/**
 * A refused credential is not raised again.
 *
 * A dropped tunnel is worth raising; a password the gateway refused is not.
 * Retrying it cannot succeed, and a FortiGate counts the attempts: that is
 * how a real account was locked, and why waiting for the lockout to lapse
 * never helped -- the next attempt arrived before it did. So a profile the
 * manager marked "refused" is left alone until someone edits it, which is the
 * only thing that can change the answer.
 */
function worthRaising(profile: VpnProfileRecord): boolean {
  // Switched off by the operator is not a state to recover from.
  if (profile.enabled === false) return false;
  return profile.lastState !== "refused";
}

export async function syncManagedNetworks(): Promise<{
  raised: number;
  skipped: number;
}> {
  const manager = resolveNetManagerOptions();
  if (!manager) return { raised: 0, skipped: 0 };

  const repository = createCurrentVpnProfileRepository();

  let profiles: VpnProfileRecord[];
  try {
    profiles = await repository.listManaged();
  } catch (error) {
    sshLogger.warn("Could not read managed networks to put them back", {
      operation: "managed_network_sync",
      error: getErrorMessage(error),
    });
    return { raised: 0, skipped: 0 };
  }
  if (profiles.length === 0) return { raised: 0, skipped: 0 };

  // A manager that cannot be reached is not an occasion to raise everything
  // blindly: without its answer there is no way to tell what is already up.
  const state = await listManagedNetworks(manager);
  if (state === null) {
    sshLogger.warn(
      "The network manager did not answer; networks left as they are",
      {
        operation: "managed_network_sync",
      },
    );
    return { raised: 0, skipped: profiles.length };
  }

  /*
   * Registered, not up.
   *
   * A VPN's doorway listens for as long as the manager knows about it; the
   * tunnel underneath comes when something connects and goes when nothing
   * does. So "down" is the resting state, not a fault, and the only thing
   * worth putting back is a VPN the manager has forgotten entirely.
   */
  const known = new Set(state.map((entry) => entry.id));

  let raised = 0;
  let skipped = 0;
  for (const profile of profiles) {
    if (known.has(profile.id)) continue;
    if (!worthRaising(profile)) {
      skipped += 1;
      continue;
    }

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
      manager,
    );

    await repository
      .updateById(profile.id, profile.userId, {
        lastState: result.state,
        lastError: result.error ?? null,
      } as never)
      .catch(() => undefined);

    if (result.state !== "error") raised += 1;
    sshLogger.info("VPN made available again", {
      operation: "managed_network_sync",
      profileId: profile.id,
      state: result.state,
    });
  }

  return { raised, skipped };
}

let timer: NodeJS.Timeout | null = null;

/**
 * Started once at boot, then on an interval.
 *
 * A minute, because a network that is down is a host that cannot be reached,
 * and the operator has no way to tell the difference between "still coming
 * back" and "broken" except by waiting. The check itself is one short
 * connection to the manager, so this is cheap; five minutes was chosen for
 * tidiness and felt like a fault.
 */
export function startManagedNetworkSync(
  intervalMs = Number(process.env.NET_MANAGER_SYNC_INTERVAL_MS ?? 60000),
): void {
  if (timer || !resolveNetManagerOptions()) return;

  void syncManagedNetworks().catch(() => undefined);
  timer = setInterval(() => {
    void syncManagedNetworks().catch(() => undefined);
  }, intervalMs);
  timer.unref();
}

export function stopManagedNetworkSync(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
