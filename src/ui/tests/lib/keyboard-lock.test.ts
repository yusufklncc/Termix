import { afterEach, describe, expect, it, vi } from "vitest";
import { attachKeyboardLock, getKeyboardLockApi } from "../../lib/keyboard-lock";

function setFullscreen(element: Element | null) {
  Object.defineProperty(document, "fullscreenElement", {
    value: element,
    configurable: true,
  });
}

function installKeyboardApi() {
  const api = {
    lock: vi.fn(() => Promise.resolve()),
    unlock: vi.fn(),
  };
  Object.defineProperty(navigator, "keyboard", {
    value: api,
    configurable: true,
  });
  return api;
}

function removeKeyboardApi() {
  Object.defineProperty(navigator, "keyboard", {
    value: undefined,
    configurable: true,
  });
}

afterEach(() => {
  removeKeyboardApi();
  setFullscreen(null);
});

describe("getKeyboardLockApi", () => {
  it("returns null where the API is missing, so callers can no-op", () => {
    removeKeyboardApi();
    expect(getKeyboardLockApi()).toBeNull();
  });

  it("ignores a partial implementation rather than calling into it", () => {
    Object.defineProperty(navigator, "keyboard", {
      value: {},
      configurable: true,
    });
    expect(getKeyboardLockApi()).toBeNull();
  });
});

describe("attachKeyboardLock", () => {
  it("does nothing but stay releasable without the API", () => {
    removeKeyboardApi();
    const handle = attachKeyboardLock();
    expect(() => handle.release()).not.toThrow();
  });

  it("locks when the document is already fullscreen at attach time", () => {
    const api = installKeyboardApi();
    setFullscreen(document.body);

    const handle = attachKeyboardLock();
    expect(api.lock).toHaveBeenCalledTimes(1);
    handle.release();
  });

  it("stays unlocked until fullscreen is entered", () => {
    const api = installKeyboardApi();
    const handle = attachKeyboardLock();
    expect(api.lock).not.toHaveBeenCalled();

    setFullscreen(document.body);
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(api.lock).toHaveBeenCalledTimes(1);

    handle.release();
  });

  it("unlocks on leaving fullscreen", () => {
    const api = installKeyboardApi();
    setFullscreen(document.body);
    const handle = attachKeyboardLock();

    setFullscreen(null);
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(api.unlock).toHaveBeenCalledTimes(1);

    handle.release();
  });

  it("does not lock twice while fullscreen stays on", () => {
    const api = installKeyboardApi();
    setFullscreen(document.body);
    const handle = attachKeyboardLock();

    document.dispatchEvent(new Event("fullscreenchange"));
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(api.lock).toHaveBeenCalledTimes(1);

    handle.release();
  });

  it("releases the lock when the session ends in fullscreen", () => {
    const api = installKeyboardApi();
    setFullscreen(document.body);
    const handle = attachKeyboardLock();

    handle.release();
    expect(api.unlock).toHaveBeenCalledTimes(1);
  });

  it("stops responding to fullscreen once released", () => {
    const api = installKeyboardApi();
    const handle = attachKeyboardLock();
    handle.release();

    setFullscreen(document.body);
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(api.lock).not.toHaveBeenCalled();
  });

  it("reports unsupported so the viewer can be told, not left guessing", () => {
    removeKeyboardApi();
    const onState = vi.fn();
    attachKeyboardLock({ onState }).release();
    expect(onState).toHaveBeenCalledWith("unsupported");
  });

  it("reports engaged and released around fullscreen", async () => {
    const api = installKeyboardApi();
    const onState = vi.fn();
    setFullscreen(document.body);

    const handle = attachKeyboardLock({ onState });
    await Promise.resolve();
    expect(onState).toHaveBeenCalledWith("engaged");

    setFullscreen(null);
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(onState).toHaveBeenCalledWith("released");

    handle.release();
    void api;
  });

  it("reports refused with the reason", async () => {
    const api = installKeyboardApi();
    api.lock.mockRejectedValueOnce(new Error("denied"));
    const onState = vi.fn();
    setFullscreen(document.body);

    const handle = attachKeyboardLock({ onState });
    await Promise.resolve();

    expect(onState).toHaveBeenCalledWith(
      "refused",
      expect.stringContaining("denied"),
    );
    handle.release();
  });

  it("recovers when the lock is refused, so a later attempt still works", async () => {
    const api = installKeyboardApi();
    api.lock.mockRejectedValueOnce(new Error("denied"));
    setFullscreen(document.body);

    const handle = attachKeyboardLock();
    await Promise.resolve();

    // The refused attempt must not leave the handle believing it holds a lock,
    // which would make it skip every later fullscreen.
    setFullscreen(null);
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(api.unlock).not.toHaveBeenCalled();

    setFullscreen(document.body);
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(api.lock).toHaveBeenCalledTimes(2);

    handle.release();
  });
});
