import { describe, expect, it } from "vitest";
import {
  KBD_FLAGS_EXTENDED,
  KBD_FLAGS_RELEASE,
  PTR_FLAGS_BUTTON1,
  PTR_FLAGS_BUTTON2,
  PTR_FLAGS_BUTTON3,
  PTR_FLAGS_HWHEEL,
  PTR_FLAGS_WHEEL,
  PTR_FLAGS_WHEEL_NEGATIVE,
  PTR_XFLAGS_BUTTON1,
  rdpButtonFlag,
  rdpExtendedButtonFlag,
  rdpKeyEvent,
  rdpWheelEvent,
} from "../../../features/rdp-direct/rdp-scancode";

describe("rdpKeyEvent", () => {
  it("maps letters and digits to set 1 scancodes", () => {
    expect(rdpKeyEvent("KeyA", true)).toEqual({ flags: 0, code: 0x1e });
    expect(rdpKeyEvent("KeyZ", true)).toEqual({ flags: 0, code: 0x2c });
    expect(rdpKeyEvent("Digit1", true)).toEqual({ flags: 0, code: 0x02 });
    expect(rdpKeyEvent("Digit0", true)).toEqual({ flags: 0, code: 0x0b });
  });

  it("sets the release flag on key up", () => {
    expect(rdpKeyEvent("KeyA", false)).toEqual({
      flags: KBD_FLAGS_RELEASE,
      code: 0x1e,
    });
  });

  it("flags extended keys rather than emitting the 0xE0 prefix", () => {
    expect(rdpKeyEvent("ArrowUp", true)).toEqual({
      flags: KBD_FLAGS_EXTENDED,
      code: 0x48,
    });
    expect(rdpKeyEvent("ControlRight", true)).toEqual({
      flags: KBD_FLAGS_EXTENDED,
      code: 0x1d,
    });
  });

  it("combines extended and release", () => {
    expect(rdpKeyEvent("Delete", false)).toEqual({
      flags: KBD_FLAGS_EXTENDED | KBD_FLAGS_RELEASE,
      code: 0x53,
    });
  });

  it("separates the two Enter keys, which share a scancode", () => {
    expect(rdpKeyEvent("Enter", true)).toEqual({ flags: 0, code: 0x1c });
    expect(rdpKeyEvent("NumpadEnter", true)).toEqual({
      flags: KBD_FLAGS_EXTENDED,
      code: 0x1c,
    });
  });

  it("separates left and right modifiers", () => {
    expect(rdpKeyEvent("ShiftLeft", true)?.code).toBe(0x2a);
    expect(rdpKeyEvent("ShiftRight", true)?.code).toBe(0x36);
    expect(rdpKeyEvent("AltLeft", true)?.flags).toBe(0);
    expect(rdpKeyEvent("AltRight", true)?.flags).toBe(KBD_FLAGS_EXTENDED);
  });

  it("uses physical position, so the layout does not change the code", () => {
    // event.code is positional: the key labelled Y on a QWERTZ keyboard still
    // reports KeyZ, and the remote side applies its own layout.
    expect(rdpKeyEvent("KeyY", true)?.code).toBe(0x15);
  });

  it("returns null for keys with no scancode instead of guessing", () => {
    expect(rdpKeyEvent("Pause", true)).toBeNull();
    expect(rdpKeyEvent("BrightnessUp", true)).toBeNull();
    expect(rdpKeyEvent("", true)).toBeNull();
  });
});

describe("rdpButtonFlag", () => {
  it("maps left, middle and right", () => {
    expect(rdpButtonFlag(0)).toBe(PTR_FLAGS_BUTTON1);
    expect(rdpButtonFlag(1)).toBe(PTR_FLAGS_BUTTON3);
    expect(rdpButtonFlag(2)).toBe(PTR_FLAGS_BUTTON2);
  });

  it("leaves the side buttons to the extended event", () => {
    expect(rdpButtonFlag(3)).toBeNull();
    expect(rdpExtendedButtonFlag(3)).toBe(PTR_XFLAGS_BUTTON1);
    expect(rdpExtendedButtonFlag(9)).toBeNull();
  });
});

describe("rdpWheelEvent", () => {
  it("marks a downward scroll negative", () => {
    const event = rdpWheelEvent(0, 120);
    expect(event!.flags & PTR_FLAGS_WHEEL).toBe(PTR_FLAGS_WHEEL);
    expect(event!.flags & PTR_FLAGS_WHEEL_NEGATIVE).toBe(
      PTR_FLAGS_WHEEL_NEGATIVE,
    );
  });

  it("leaves an upward scroll positive", () => {
    const event = rdpWheelEvent(0, -120);
    expect(event!.flags & PTR_FLAGS_WHEEL).toBe(PTR_FLAGS_WHEEL);
    expect(event!.flags & PTR_FLAGS_WHEEL_NEGATIVE).toBe(0);
  });

  it("uses the horizontal wheel for a horizontal delta", () => {
    const event = rdpWheelEvent(50, 0);
    expect(event!.flags & PTR_FLAGS_HWHEEL).toBe(PTR_FLAGS_HWHEEL);
  });

  it("clamps the rotation into the low byte", () => {
    const event = rdpWheelEvent(0, -99999);
    expect(event!.flags & 0xff).toBe(255);
  });

  it("returns null when nothing moved", () => {
    expect(rdpWheelEvent(0, 0)).toBeNull();
  });
});
