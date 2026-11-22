/**
 * Switching to another tab and back keeps the session.
 *
 * Reported on 26.11.3: coming back to a Direct RDP tab started the session
 * over from the login screen. The tab hands the app a fresh getWsTarget on
 * every render, the shell re-renders a tab when it is shown again, and the
 * session effect depended on getWsTarget -- so it closed the session and
 * opened a new one.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

const client = vi.hoisted(() => ({
  connect: vi.fn(),
  close: vi.fn(),
}));

vi.mock("../../src/frontend/rdp-direct-client", () => ({
  connectRdpDirect: (...args: unknown[]) => {
    client.connect(...args);
    return {
      close: client.close,
      reconnect: vi.fn(),
      isConnected: () => true,
      send: vi.fn(),
    };
  },
}));

vi.mock("@termix-ssh/plugin-sdk/frontend", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

// The app only tries to connect where the browser can decode.
vi.stubGlobal("VideoDecoder", class {});
Object.defineProperty(window, "isSecureContext", { value: true });

const { default: RdpDirectApp } =
  await import("../../src/frontend/RdpDirectApp");

const target = () =>
  Promise.resolve({ url: "wss://termix.test/plugin-ws/rdp-direct/session" });

afterEach(() => {
  cleanup();
  client.connect.mockClear();
  client.close.mockClear();
});

describe("a Direct RDP tab shown again", () => {
  it("keeps its session when the tab renders with a new getWsTarget", async () => {
    const view = render(
      <RdpDirectApp hostId="7" getWsTarget={() => target()} />,
    );
    await vi.waitFor(() => expect(client.connect).toHaveBeenCalledTimes(1));

    // What the shell does when the tab is switched back to.
    await act(async () => {
      view.rerender(<RdpDirectApp hostId="7" getWsTarget={() => target()} />);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.close).not.toHaveBeenCalled();
  });

  it("still starts a new session for another host", async () => {
    const view = render(<RdpDirectApp hostId="7" getWsTarget={target} />);
    await vi.waitFor(() => expect(client.connect).toHaveBeenCalledTimes(1));
    await act(async () => {
      view.rerender(<RdpDirectApp hostId="8" getWsTarget={target} />);
    });
    await vi.waitFor(() => expect(client.connect).toHaveBeenCalledTimes(2));
    expect(client.close).toHaveBeenCalledTimes(1);
  });
});
