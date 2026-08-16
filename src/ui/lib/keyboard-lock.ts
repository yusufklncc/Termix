/**
 * Keyboard Lock, tied to fullscreen.
 *
 * A remote desktop wants every keystroke, but the browser keeps some for
 * itself. Ctrl+W, Ctrl+T and friends are reserved: preventDefault() does not
 * reach them, so Ctrl+W in a remote session closes the Termix tab instead.
 *
 * The Keyboard Lock API is the only way to claim them, and it only applies
 * while the document is fullscreen -- so this listens for fullscreen rather
 * than exposing a control of its own, and works with whatever fullscreen
 * button the app already has.
 *
 * Every key is locked, Escape included, because a remote desktop needs Escape.
 * The browser then requires holding it to leave fullscreen and says so itself.
 *
 * Chromium-only today; elsewhere this is a no-op and the reserved shortcuts
 * keep their browser meaning.
 */

import { systemLogger } from "@/lib/frontend-logger";

interface KeyboardLockApi {
  lock(keyCodes?: string[]): Promise<void>;
  unlock(): void;
}

export interface KeyboardLockHandle {
  release(): void;
}

export function getKeyboardLockApi(): KeyboardLockApi | null {
  if (typeof navigator === "undefined") return null;
  const candidate = (navigator as Navigator & { keyboard?: KeyboardLockApi })
    .keyboard;
  if (!candidate || typeof candidate.lock !== "function") return null;
  return candidate;
}

/**
 * Locks the keyboard whenever the document is fullscreen, until released.
 *
 * Safe to call when the API is missing or already in fullscreen: it picks up
 * the current state rather than waiting for the next change.
 */
export function attachKeyboardLock(): KeyboardLockHandle {
  const keyboard = getKeyboardLockApi();
  if (!keyboard) {
    // Whether the browser has the API at all is the first thing worth knowing
    // when a shortcut still escapes to the browser.
    systemLogger.warn(
      "Keyboard lock unavailable: navigator.keyboard is missing, reserved shortcuts stay with the browser",
    );
    return { release() {} };
  }

  let locked = false;

  const sync = () => {
    const wantLock =
      typeof document !== "undefined" && !!document.fullscreenElement;

    if (wantLock && !locked) {
      locked = true;
      // Two-argument then, not then().catch(): the rejection handler has to
      // clear `locked` on the same tick the promise settles, or a release in
      // between would unlock a lock that was never taken.
      keyboard.lock().then(
        () => {
          systemLogger.info("Keyboard lock engaged");
        },
        (error: unknown) => {
          // Rejects when something else holds the lock, or when fullscreen
          // went away between the event and this call. The session keeps
          // working either way -- only the reserved shortcuts stay with the
          // browser, which is exactly the symptom worth naming.
          locked = false;
          systemLogger.warn(`Keyboard lock refused: ${String(error)}`);
        },
      );
      return;
    }

    if (!wantLock && locked) {
      locked = false;
      try {
        keyboard.unlock();
      } catch {
        // Already released by leaving fullscreen.
      }
    }
  };

  document.addEventListener("fullscreenchange", sync);
  sync();

  return {
    release() {
      document.removeEventListener("fullscreenchange", sync);
      if (locked) {
        locked = false;
        try {
          keyboard.unlock();
        } catch {
          // Already released.
        }
      }
    },
  };
}
