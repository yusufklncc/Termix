import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { useCommandHistory } from "../../../src/frontend/terminal/command-history/CommandHistoryContext";

vi.mock("../../../src/frontend/terminal/Terminal", () => ({
  Terminal: () => {
    useCommandHistory();
    return <div>terminal</div>;
  },
}));

vi.mock("@termix-ssh/plugin-sdk/ui", () => ({
  FullScreenAppWrapper: ({
    children,
  }: {
    children: (host: unknown, phase: string) => ReactNode;
  }) => <>{children({ id: 15, name: "web", ip: "10.0.0.1" }, "ready")}</>,
  ConnectionScreen: () => null,
}));

vi.mock("@termix-ssh/plugin-sdk/frontend", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import TerminalApp from "../../../src/frontend/terminal/TerminalApp";

afterEach(cleanup);

describe("TerminalApp", () => {
  it("renders the terminal inside a command history provider", () => {
    render(<TerminalApp hostId="15" />);
    expect(screen.getByText("terminal")).toBeTruthy();
  });
});
