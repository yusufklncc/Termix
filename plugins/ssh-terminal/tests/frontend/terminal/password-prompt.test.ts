import { describe, expect, it } from "vitest";
import {
  isPasswordPrompt,
  isSudoCommand,
  isSudoPrompt,
} from "../../../src/frontend/terminal/password-prompt";

describe("isPasswordPrompt", () => {
  it("matches sudo, sudo-rs, macOS and SSH prompts", () => {
    expect(isPasswordPrompt("[sudo] password for luke: ")).toBe(true);
    expect(isPasswordPrompt("[sudo: authenticate] Password: ")).toBe(true);
    expect(isPasswordPrompt("Password:")).toBe(true);
    expect(isPasswordPrompt("root@host's password: ")).toBe(true);
  });

  it("ignores ordinary output", () => {
    expect(isPasswordPrompt("luke@host:~$ ")).toBe(false);
    expect(isPasswordPrompt("Password: ok\nluke@host:~$ ")).toBe(false);
  });
});

describe("isSudoPrompt", () => {
  it("knows Linux sudo by its prompt", () => {
    expect(isSudoPrompt("[sudo] password for luke: ", "")).toBe(true);
    expect(isSudoPrompt("[sudo: authenticate] Password: ", "")).toBe(true);
  });

  it("knows macOS sudo by the command that was run", () => {
    expect(isSudoPrompt("Password:", "sudo ls /var/root")).toBe(true);
    expect(isSudoPrompt("Password:", "cd /etc && sudo vim hosts")).toBe(true);
    expect(isSudoPrompt("Sorry, try again.\nPassword:", "")).toBe(true);
  });

  it("treats a bare prompt after another command as a login prompt", () => {
    expect(isSudoPrompt("Password:", "ssh other-host")).toBe(false);
    expect(isSudoPrompt("Password:", "echo pseudo")).toBe(false);
  });
});

describe("isSudoCommand", () => {
  it("finds sudo as a word only", () => {
    expect(isSudoCommand("sudo -i")).toBe(true);
    expect(isSudoCommand("ls; sudo reboot")).toBe(true);
    expect(isSudoCommand("sudoedit file")).toBe(false);
    expect(isSudoCommand("visudo")).toBe(false);
  });
});
