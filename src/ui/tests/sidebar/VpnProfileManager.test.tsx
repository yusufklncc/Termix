import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const createVpnProfile = vi.hoisted(() =>
  vi.fn(async (_payload: Record<string, unknown>) => ({})),
);
const updateVpnProfile = vi.hoisted(() => vi.fn(async () => ({})));
const deleteVpnProfile = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("@/main-axios", () => ({
  createVpnProfile,
  updateVpnProfile,
  deleteVpnProfile,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { VpnProfileManager } from "@/sidebar/VpnProfileManager";
import type { VpnProfile } from "@/types/ui-types";

function setup(profiles: VpnProfile[] = []) {
  render(
    <VpnProfileManager
      profiles={profiles}
      onChanged={vi.fn()}
      onClose={vi.fn()}
    />,
  );
}

function typeInto(label: string, value: string) {
  const input = screen
    .getByText(label)
    .parentElement!.querySelector("input") as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
}

afterEach(() => {
  cleanup();
  createVpnProfile.mockClear();
});

describe("making a managed profile", () => {
  it("sends what to dial and as whom, with the port as a number", async () => {
    setup();
    fireEvent.click(screen.getByText("hosts.vpn.kindManaged"));

    typeInto("hosts.vpn.name", "Acme");
    typeInto("hosts.vpn.serverHost", "vpn.acme.example");
    typeInto("hosts.vpn.serverPort", "10443");
    typeInto("hosts.vpn.authUsername", "someone");
    typeInto("hosts.vpn.authPassword", "a-secret");

    fireEvent.click(screen.getByText("common.save"));

    await waitFor(() => expect(createVpnProfile).toHaveBeenCalled());
    expect(createVpnProfile.mock.calls[0][0]).toMatchObject({
      kind: "managed",
      provider: "fortinet",
      serverHost: "vpn.acme.example",
      serverPort: 10443,
      authUsername: "someone",
      authPassword: "a-secret",
    });
  });

  it("does not ask for an address, because the manager answers with one", () => {
    setup();
    fireEvent.click(screen.getByText("hosts.vpn.kindManaged"));
    expect(screen.queryByText("hosts.vpn.gatewayHost")).not.toBeInTheDocument();
  });

  it("still asks for one when the operator runs the tunnel", () => {
    setup();
    fireEvent.click(screen.getByText("hosts.vpn.kindDeclared"));
    expect(screen.getByText("hosts.vpn.gatewayHost")).toBeInTheDocument();
    expect(screen.queryByText("hosts.vpn.serverHost")).not.toBeInTheDocument();
  });
});

describe("what the manager last said", () => {
  const managed = {
    id: "1",
    name: "Acme",
    kind: "managed",
    gatewayType: "socks5",
    gatewayHost: "termix-netmgr",
    gatewayPort: 20001,
    hasGatewayPassword: false,
    provider: "fortinet",
    serverHost: "vpn.acme.example",
  } as VpnProfile;

  it("shows the state of a managed profile", () => {
    setup([{ ...managed, lastState: "up" }]);
    expect(screen.getByText("hosts.vpn.stateUp")).toBeInTheDocument();
  });

  it("carries the reason a failed one gives", () => {
    setup([{ ...managed, lastState: "error", lastError: "no route to host" }]);
    expect(screen.getByText("hosts.vpn.stateError")).toHaveAttribute(
      "title",
      "no route to host",
    );
  });

  it("says nothing for a profile nobody reports on", () => {
    setup([{ ...managed, kind: "declared", lastState: undefined }]);
    expect(screen.queryByText("hosts.vpn.stateUp")).not.toBeInTheDocument();
  });
});
