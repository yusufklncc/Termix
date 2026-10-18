import { afterEach, describe, expect, it } from "vitest";
import {
  enabledHostProtocols,
  hostProtocolFlags,
  protocolPort,
  registerHostProtocol,
  withProtocolSettings,
  type HostProtocolDef,
} from "../../sidebar/host-protocols";
import { isFieldShown } from "../../settings/settings-fields-util";
import { readFileSync } from "node:fs";
import path from "node:path";

const desktop: HostProtocolDef = {
  id: "demo-desktop",
  pluginId: "demo",
  settingKey: "enableDemo",
  portKey: "demoPort",
  defaultPort: 3389,
  titleKey: "demo:title",
  icon: () => null,
};

let dispose: (() => void) | null = null;

afterEach(() => {
  dispose?.();
  dispose = null;
});

describe("host protocols", () => {
  it("reads a protocol's switch from its plugin's host settings", () => {
    dispose = registerHostProtocol(desktop);
    const host = {
      enableSsh: false,
      pluginSettings: { demo: { enableDemo: true } },
    };
    expect(hostProtocolFlags(host)).toEqual({
      enableSsh: false,
      enableDemo: true,
    });
    expect(enabledHostProtocols(host).map((p) => p.id)).toEqual([
      "demo-desktop",
    ]);
    expect(hostProtocolFlags(null)).toEqual({
      enableSsh: true,
      enableDemo: false,
    });
  });

  it("falls back to the default port", () => {
    expect(protocolPort({ demo: { demoPort: 3390 } }, desktop)).toBe(3390);
    expect(protocolPort({ demo: { demoPort: "x" } }, desktop)).toBe(3389);
    expect(protocolPort(undefined, desktop)).toBe(3389);
  });

  it("writes the editor's switches into each owner's settings", () => {
    dispose = registerHostProtocol(desktop);
    expect(
      withProtocolSettings(
        { demo: { demoPort: 3390 }, other: { a: 1 } },
        { enableSsh: true, enableDemo: true },
      ),
    ).toEqual({
      demo: { demoPort: 3390, enableDemo: true },
      other: { a: 1 },
    });
  });

  it("forgets a protocol once its plugin unregisters it", () => {
    dispose = registerHostProtocol(desktop);
    dispose();
    dispose = null;
    expect(
      enabledHostProtocols({ pluginSettings: { demo: { enableDemo: true } } }),
    ).toEqual([]);
  });
});

/**
 * The switch and the fields it turns on have to agree while editing.
 *
 * A protocol's switch is the host editor's own state and only reached
 * pluginSettings when the host was saved, so a plugin gating its fields on
 * that key with `requires` showed an empty section until the host had been
 * saved and reopened. Turning the protocol on did nothing visible, which
 * reads as a feature that does not work.
 */
describe("the switch and the fields it gates", () => {
  const gated = {
    key: "port",
    type: "number" as const,
    labelKey: "port.label",
    requires: "enableDemo",
  };

  it("hides the gated field while the switch is off", () => {
    const merged = withProtocolSettings(
      {},
      {
        enableSsh: true,
        enableDemo: false,
      } as never,
      [desktop],
    );
    expect(isFieldShown(gated, merged.demo ?? {})).toBe(false);
  });

  it("shows it as soon as the switch is on, before anything is saved", () => {
    const merged = withProtocolSettings(
      {},
      {
        enableSsh: true,
        enableDemo: true,
      } as never,
      [desktop],
    );
    expect(isFieldShown(gated, merged.demo ?? {})).toBe(true);
  });

  it("is what the editor merges on every toggle, not only on save", () => {
    /*
     * The merge used to happen in the save handler alone. Asserted on the
     * source because the alternative is driving the whole host editor, and
     * what matters is that the toggle writes the form at all.
     */
    const source = readFileSync(
      path.join(import.meta.dirname, "../../sidebar/HostEditor.tsx"),
      "utf8",
    );
    const handler = source.slice(source.indexOf("const handleProtocolToggle"));
    const body = handler.slice(0, handler.indexOf("\n  };"));
    expect(body).toContain("withProtocolSettings");
    expect(body).toContain("pluginSettings");
  });
});
