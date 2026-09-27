import { authApi, handleApiError } from "@/main-axios";

export interface VpnProfilePayload {
  name: string;
  description?: string | null;
  folder?: string | null;
  tags?: string | null;
  kind?: string;
  gatewayType?: string;
  gatewayHost: string;
  gatewayPort: number;
  gatewayUsername?: string | null;
  /** Omitted on update to keep the stored secret; empty string clears it. */
  gatewayPassword?: string | null;
}

export async function getVpnProfiles(): Promise<Record<string, unknown>[]> {
  try {
    const response = await authApi.get("/vpn/profiles");
    return response.data;
  } catch (error) {
    throw handleApiError(error, "fetch network profiles");
  }
}

export async function createVpnProfile(
  payload: VpnProfilePayload,
): Promise<Record<string, unknown>> {
  try {
    const response = await authApi.post("/vpn/profiles", payload);
    return response.data;
  } catch (error) {
    throw handleApiError(error, "create network profile");
  }
}

export async function updateVpnProfile(
  id: number,
  payload: Partial<VpnProfilePayload>,
): Promise<Record<string, unknown>> {
  try {
    const response = await authApi.put(`/vpn/profiles/${id}`, payload);
    return response.data;
  } catch (error) {
    throw handleApiError(error, "update network profile");
  }
}

export async function deleteVpnProfile(
  id: number,
): Promise<Record<string, unknown>> {
  try {
    const response = await authApi.delete(`/vpn/profiles/${id}`);
    return response.data;
  } catch (error) {
    throw handleApiError(error, "delete network profile");
  }
}
