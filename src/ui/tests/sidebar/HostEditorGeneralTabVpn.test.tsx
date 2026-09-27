import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const getVpnProfiles = vi.hoisted(() => vi.fn());
vi.mock("@/main-axios", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getVpnProfiles,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { HostEditorGeneralTab } from "@/sidebar/HostEditorGeneralTab";
import { createHostEditorForm } from "@/sidebar/HostEditorData";

function setup(setField = vi.fn()) {
  render(
    <HostEditorGeneralTab
      form={createHostEditorForm(null)}
      setField={setField as never}
      protocols={{ ssh: true } as never}
      handleProtocolToggle={vi.fn()}
      hosts={[]}
      host={null}
    />,
  );
  return setField;
}

afterEach(cleanup);

describe("host editor, network selector", () => {
  it("renders when the profile list arrives", async () => {
    getVpnProfiles.mockResolvedValue([{ id: 1, name: "TIM" }]);
    setup();
    await waitFor(() =>
      expect(screen.getByText("hosts.vpn.manage")).toBeInTheDocument(),
    );
  });

  it("survives a list endpoint that answers with something that is not a list", async () => {
    // An unmatched API path falls through to the SPA and answers 200 with
    // HTML. Rendering must not take the whole page down over it.
    getVpnProfiles.mockResolvedValue("<!doctype html>" as never);
    setup();
    await waitFor(() =>
      expect(screen.getByText("hosts.vpn.manage")).toBeInTheDocument(),
    );
  });
});

describe("choosing a network", () => {
  it("writes the chosen profile into the form", async () => {
    getVpnProfiles.mockResolvedValue([{ id: 1, name: "TIM" }]);
    const setField = setup();
    const option = await screen.findByRole("option", { name: "TIM" });
    const select = option.closest("select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "1" } });
    expect(setField).toHaveBeenCalledWith("vpnProfileId", "1");
  });
});
