import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { ConnectionScreen } from "../../../components/connection/ConnectionScreen";
import { ConnectionLogProvider } from "../../../ssh/connection-log/ConnectionLogContext";

afterEach(cleanup);

describe("ConnectionScreen", () => {
  // Loading and host-not-found screens render before the provider is mounted,
  // which used to throw and take down the whole RDP/VNC/Telnet tab.
  it("renders without a ConnectionLogProvider", () => {
    expect(() =>
      render(<ConnectionScreen status="connecting" message="common.loading" />),
    ).not.toThrow();

    expect(screen.getByText("common.loading")).toBeTruthy();
    const status = screen.getByRole("status");
    expect(status.getAttribute("data-status")).toBe("connecting");
    expect(status.querySelector(".animate-spin")).toBeTruthy();
  });

  it("renders the disconnected state without a provider", () => {
    expect(() =>
      render(
        <ConnectionScreen
          status="disconnected"
          message="remoteDesktop.hostNotFound"
        />,
      ),
    ).not.toThrow();

    expect(screen.getByText("remoteDesktop.hostNotFound")).toBeTruthy();
    expect(screen.getByRole("status").getAttribute("data-status")).toBe(
      "disconnected",
    );
  });

  it("does not say connecting and disconnected at once", () => {
    // The terminal passes a standing "connecting" message and a retry
    // handler, so both lines rendered on the same screen: one claiming the
    // connection was being made, the other that it was lost.
    render(
      <ConnectionScreen
        status="disconnected"
        message="terminal.connecting"
        disconnectedMessage="terminal.connectionLost"
        onManualRetry={() => {}}
      />,
    );

    expect(screen.queryByText("terminal.connecting")).toBeNull();
    expect(screen.getByText("terminal.connectionLost")).toBeTruthy();
  });

  it("keeps the message when a disconnected screen has no retry", () => {
    // Then it is the only thing saying what happened -- remote-desktop uses
    // it for a host that is not there.
    render(
      <ConnectionScreen
        status="disconnected"
        message="remoteDesktop.hostNotFound"
      />,
    );

    expect(screen.getByText("remoteDesktop.hostNotFound")).toBeTruthy();
  });

  it("still shows the connection log when a provider is present", () => {
    render(
      <ConnectionLogProvider>
        <ConnectionScreen status="connecting" message="common.loading" />
      </ConnectionLogProvider>,
    );

    expect(screen.getByText(/terminal\.connectionLogTitle/)).toBeTruthy();
  });
});
