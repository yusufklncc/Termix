import { describe, expect, it, vi } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { createHostVpnSection } from "../../src/frontend/HostVpnSection";
import type { VpnApi, VpnProfile } from "../../src/frontend/api";

vi.mock("@termix-ssh/plugin-sdk/frontend", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@termix-ssh/plugin-sdk/ui", () => ({
  SettingRow: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

const profiles = [
  { id: "7", name: "Acme" },
  { id: "9", name: "Beta" },
] as VpnProfile[];

const api = { list: async () => profiles } as unknown as VpnApi;

/**
 * Which network a host is on, read from and written to the one place the
 * editor carries it.
 *
 * A plugin's host settings travel on form.pluginSettings under its own id.
 * Reading the form itself instead is quiet: the field is simply always empty,
 * so the editor says "direct" for a host that has a network -- and saving
 * from that form writes the emptiness back, which is how a host quietly stops
 * going through its VPN. That has happened here before.
 */
describe("the host's VPN section", () => {
  it("shows the network the host is already on", async () => {
    const Section = createHostVpnSection(api);
    const { container } = render(
      <Section
        form={{ pluginSettings: { vpn: { profileId: 9 } } }}
        setField={vi.fn()}
        updateForm={vi.fn()}
        protocols={{}}
      />,
    );

    await waitFor(() =>
      expect(container.querySelectorAll("option")).toHaveLength(3),
    );
    expect((container.querySelector("select") as HTMLSelectElement).value).toBe(
      "9",
    );
  });

  it("says direct for a host with none", async () => {
    const Section = createHostVpnSection(api);
    const { container } = render(
      <Section
        form={{ pluginSettings: {} }}
        setField={vi.fn()}
        updateForm={vi.fn()}
        protocols={{}}
      />,
    );

    await waitFor(() => expect(container.querySelector("select")).toBeTruthy());
    expect((container.querySelector("select") as HTMLSelectElement).value).toBe(
      "",
    );
  });

  it("writes the choice where the editor saves it from", async () => {
    const Section = createHostVpnSection(api);
    const updateForm = vi.fn();
    const { container } = render(
      <Section
        form={{ pluginSettings: { vpn: { profileId: 7 } } }}
        setField={vi.fn()}
        updateForm={updateForm}
        protocols={{}}
      />,
    );

    await waitFor(() =>
      expect(container.querySelectorAll("option")).toHaveLength(3),
    );
    fireEvent.change(container.querySelector("select")!, {
      target: { value: "9" },
    });

    const patch = updateForm.mock.calls[0][0] as (
      form: Record<string, unknown>,
    ) => Record<string, unknown>;
    // The name travels with the id: an exported host carries it, and the
    // gateway trusts it over an id that means nothing in another account.
    expect(patch({ pluginSettings: { vpn: { profileId: 7 } } })).toEqual({
      pluginSettings: { vpn: { profileId: 9, profileName: "Beta" } },
    });
  });

  it("clears the name along with the choice", async () => {
    const Section = createHostVpnSection(api);
    const updateForm = vi.fn();
    const { container } = render(
      <Section
        form={{
          pluginSettings: { vpn: { profileId: 7, profileName: "Acme" } },
        }}
        setField={vi.fn()}
        updateForm={updateForm}
        protocols={{}}
      />,
    );

    await waitFor(() =>
      expect(container.querySelectorAll("option")).toHaveLength(3),
    );
    fireEvent.change(container.querySelector("select")!, {
      target: { value: "" },
    });

    const patch = updateForm.mock.calls[0][0] as (
      form: Record<string, unknown>,
    ) => Record<string, unknown>;
    // A stale name would send the host out through a network it was taken
    // off, since the gateway prefers the name.
    expect(
      patch({ pluginSettings: { vpn: { profileId: 7, profileName: "Acme" } } }),
    ).toEqual({
      pluginSettings: { vpn: { profileId: null, profileName: null } },
    });
  });

  it("keeps another plugin's settings when it writes", async () => {
    const Section = createHostVpnSection(api);
    const updateForm = vi.fn();
    const { container } = render(
      <Section
        form={{ pluginSettings: {} }}
        setField={vi.fn()}
        updateForm={updateForm}
        protocols={{}}
      />,
    );

    await waitFor(() =>
      expect(container.querySelectorAll("option")).toHaveLength(3),
    );
    fireEvent.change(container.querySelector("select")!, {
      target: { value: "7" },
    });

    const patch = updateForm.mock.calls[0][0] as (
      form: Record<string, unknown>,
    ) => Record<string, unknown>;
    expect(
      patch({ pluginSettings: { docker: { enableDocker: true } } }),
    ).toEqual({
      pluginSettings: {
        docker: { enableDocker: true },
        vpn: { profileId: 7, profileName: "Acme" },
      },
    });
  });
});
