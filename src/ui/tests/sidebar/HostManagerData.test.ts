import { describe, expect, it } from "vitest";
import { sshHostToHost } from "../../sidebar/HostManagerData";
import type { SSHHostWithStatus } from "@/main-axios";

function apiHost(overrides: Record<string, unknown> = {}): SSHHostWithStatus {
  return {
    id: 1,
    name: "box",
    ip: "10.0.0.5",
    port: 8080,
    username: "",
    authType: "none",
    folder: "",
    tags: [],
    ...overrides,
  } as unknown as SSHHostWithStatus;
}

/**
 * sshHostToHost maps the API response field by field, so a column added to the
 * backend is invisible to the editor until it is listed here too. That is not
 * hypothetical: the stream fields round-tripped through the database correctly
 * while the editor showed an empty form, because this mapper dropped them.
 */
describe("sshHostToHost stream fields", () => {
  it("carries every stream field through to the editor", () => {
    const host = sshHostToHost(
      apiHost({
        connectionType: "stream",
        enableSsh: false,
        enableStream: true,
        streamUrl: "http://10.0.0.5:8080",
        streamPath: "/session",
        streamMode: "webrtc",
        streamPublisher: "neko",
        streamAuthType: "direct",
        streamUser: "admin",
        hasStreamPassword: true,
      }),
    );

    expect(host.enableStream).toBe(true);
    expect(host.streamUrl).toBe("http://10.0.0.5:8080");
    expect(host.streamPath).toBe("/session");
    expect(host.streamMode).toBe("webrtc");
    expect(host.streamPublisher).toBe("neko");
    expect(host.streamAuthType).toBe("direct");
    expect(host.streamUser).toBe("admin");
    expect(host.hasStreamPassword).toBe(true);
  });

  it("infers enableStream from connectionType on rows predating the flag", () => {
    const host = sshHostToHost(
      apiHost({ connectionType: "stream", enableSsh: false }),
    );
    expect(host.enableStream).toBe(true);
  });

  it("leaves stream off for an ordinary ssh host", () => {
    const host = sshHostToHost(apiHost({ connectionType: "ssh" }));
    expect(host.enableStream).toBe(false);
  });

  it("defaults mode to embed so hosts created before webrtc keep rendering", () => {
    const host = sshHostToHost(
      apiHost({ enableStream: true, streamUrl: "http://a.example" }),
    );
    expect(host.streamMode).toBe("embed");
  });

  it("reads credential mode from a stored credential id", () => {
    const host = sshHostToHost(
      apiHost({ enableStream: true, streamCredentialId: 7 }),
    );
    expect(host.streamAuthType).toBe("credential");
    expect(host.streamCredentialId).toBe("7");
  });
});
