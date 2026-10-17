import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";

export interface RdpDirectHostSettings {
  enabled: boolean;
  port: number;
  printing: boolean;
}

export const DEFAULT_PORT = 3389;

function asPort(value: unknown): number | undefined {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

/** This host's Direct RDP settings, as the editor wrote them. */
export async function readHostSettings(
  ctx: PluginContext,
  hostId: number,
): Promise<RdpDirectHostSettings> {
  const values = await ctx.settings.getAll("host", hostId);
  return {
    enabled: values.enableRdpDirect === true,
    port: asPort(values.port) ?? DEFAULT_PORT,
    /*
     * Off unless asked for, per host, because the cost of getting it wrong is
     * the whole session: printing rides on device redirection, and a host
     * that refuses the printer refuses to connect at all.
     */
    printing: values.enablePrinting === true,
  };
}
