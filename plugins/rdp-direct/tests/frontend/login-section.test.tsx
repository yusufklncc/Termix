/**
 * Somewhere to enter Direct RDP's login.
 *
 * Reported from the field as "Direct RDP does not know which credential to
 * use". It did not: the plugin had no login form, the server looked for a
 * login under "rdp-direct" that nothing wrote, and every connection fell back
 * to the host's SSH login -- the SSH user, no domain, and no password when SSH
 * signs in with a key. RDP's login form, the only one, is shown only while RDP
 * itself is switched on.
 *
 * This section edits that same RDP login, so there is one Windows account per
 * host whichever renderer opens it.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import { HOST_PROTOCOL_SECRET_KEPT } from "@termix-ssh/plugin-sdk/frontend";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import {
  loginSectionVisible,
  patchRdpLogin,
} from "../../src/frontend/LoginSection";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";

const manifest = manifestJson as unknown as PluginManifest;

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
});

/** A form and an updateForm that applies patches to it, like the editor. */
function editor(initial: Record<string, unknown>) {
  let form = { ...initial };
  const updateForm = vi.fn(
    (patch: (current: Record<string, unknown>) => Record<string, unknown>) => {
      form = { ...form, ...patch(form) };
    },
  );
  return {
    get form() {
      return form;
    },
    updateForm,
  };
}

describe("when the section is offered", () => {
  it("is offered with Direct RDP on and RDP off", () => {
    expect(loginSectionVisible({ enableRdpDirect: true })).toBe(true);
  });

  it("is not, with RDP on: RDP's own form shows this login already", () => {
    expect(
      loginSectionVisible({ enableRdpDirect: true, enableRdp: true }),
    ).toBe(false);
  });

  it("is not, with Direct RDP off", () => {
    expect(loginSectionVisible({ enableRdp: true })).toBe(false);
    expect(loginSectionVisible({})).toBe(false);
  });

  it("is registered", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    expect(rendered.registered.hostEditorSections()).toContain(
      "rdp-direct-login",
    );
  });
});

describe("what it writes", () => {
  it("writes RDP's login, not one of Direct RDP's own", () => {
    const next = patchRdpLogin({}, { username: "yusuf" });
    expect(next.protocolAuth).toMatchObject({ rdp: { username: "yusuf" } });
    expect(next.protocolAuth).not.toHaveProperty("rdp-direct");
  });

  it("leaves the other logins, and the rest of this one, alone", () => {
    const next = patchRdpLogin(
      {
        protocolAuth: {
          vnc: { authType: "direct", username: "v" },
          rdp: { authType: "direct", username: "old", fields: { domain: "D" } },
        },
      },
      { username: "new" },
    );
    expect(next.protocolAuth).toMatchObject({
      vnc: { username: "v" },
      rdp: { username: "new", fields: { domain: "D" } },
    });
  });
});

describe("the form", () => {
  it("puts what is typed into the RDP login", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    const state = editor({ protocolAuth: {} });
    rendered.renderHostEditorSection("rdp-direct-login", {
      form: state.form,
      updateForm: state.updateForm,
      protocols: { enableRdpDirect: true },
      credentials: [],
    });

    fireEvent.change(screen.getByLabelText("Username"), {
      target: { value: "yusuf" },
    });
    fireEvent.change(screen.getByLabelText("Domain"), {
      target: { value: "LENOVO" },
    });

    expect(state.form.protocolAuth).toMatchObject({
      rdp: { username: "yusuf", fields: { domain: "LENOVO" } },
    });
  });

  it("does not resend a saved password nobody touched", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    const state = editor({
      protocolAuth: {
        rdp: {
          authType: "direct",
          username: "yusuf",
          password: HOST_PROTOCOL_SECRET_KEPT,
          fields: {},
        },
      },
    });
    rendered.renderHostEditorSection("rdp-direct-login", {
      form: state.form,
      updateForm: state.updateForm,
      protocols: { enableRdpDirect: true },
      credentials: [],
    });

    // The field is empty with a placeholder saying it is saved.
    const password = screen.getByLabelText("Password") as HTMLInputElement;
    expect(password.value).toBe("");
    expect(password.placeholder).toMatch(/saved/i);

    // Changing something else keeps the sentinel, so the save leaves the
    // stored password where it is.
    fireEvent.change(screen.getByLabelText("Domain"), {
      target: { value: "LENOVO" },
    });
    expect(
      (state.form.protocolAuth as Record<string, { password: string }>).rdp
        .password,
    ).toBe(HOST_PROTOCOL_SECRET_KEPT);
  });

  it("says the login is shared with RDP", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    rendered.renderHostEditorSection("rdp-direct-login", {
      form: { protocolAuth: {} },
      updateForm: vi.fn(),
      protocols: { enableRdpDirect: true },
      credentials: [],
    });
    expect(screen.getByText(/same Windows account RDP/)).toBeTruthy();
  });
});
