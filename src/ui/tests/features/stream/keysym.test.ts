import { describe, expect, it } from "vitest";
import {
  buttonCodeFromEvent,
  keysymFromEvent,
} from "../../../features/stream/keysym";

describe("keysymFromEvent", () => {
  it("maps ASCII printables to their own code point", () => {
    expect(keysymFromEvent({ key: "a" })).toBe(0x61);
    expect(keysymFromEvent({ key: "A" })).toBe(0x41);
    expect(keysymFromEvent({ key: " " })).toBe(0x20);
    expect(keysymFromEvent({ key: "/" })).toBe(0x2f);
  });

  it("maps Latin-1 to its code point and other Unicode to the 0x01000000 plane", () => {
    expect(keysymFromEvent({ key: "ö" })).toBe(0xf6);
    // Turkish dotless i is outside Latin-1.
    expect(keysymFromEvent({ key: "ı" })).toBe(0x01000000 + 0x0131);
    expect(keysymFromEvent({ key: "ş" })).toBe(0x01000000 + 0x015f);
  });

  it("maps named keys", () => {
    expect(keysymFromEvent({ key: "Enter" })).toBe(0xff0d);
    expect(keysymFromEvent({ key: "Backspace" })).toBe(0xff08);
    expect(keysymFromEvent({ key: "Escape" })).toBe(0xff1b);
    expect(keysymFromEvent({ key: "ArrowLeft" })).toBe(0xff51);
    expect(keysymFromEvent({ key: "Delete" })).toBe(0xffff);
  });

  it("distinguishes left and right modifiers through event.code", () => {
    expect(keysymFromEvent({ key: "Shift", code: "ShiftLeft" })).toBe(0xffe1);
    expect(keysymFromEvent({ key: "Shift", code: "ShiftRight" })).toBe(0xffe2);
    expect(keysymFromEvent({ key: "Control", code: "ControlRight" })).toBe(
      0xffe4,
    );
    expect(keysymFromEvent({ key: "Alt", code: "AltLeft" })).toBe(0xffe9);
  });

  it("maps the function row", () => {
    expect(keysymFromEvent({ key: "F1" })).toBe(0xffbe);
    expect(keysymFromEvent({ key: "F12" })).toBe(0xffc9);
  });

  it("maps numpad Enter apart from the main Enter", () => {
    expect(keysymFromEvent({ key: "Enter", code: "NumpadEnter" })).toBe(0xff8d);
    expect(keysymFromEvent({ key: "Enter", code: "Enter" })).toBe(0xff0d);
  });

  it("ignores keys with no remote meaning", () => {
    expect(keysymFromEvent({ key: "Dead" })).toBeNull();
    expect(keysymFromEvent({ key: "Unidentified" })).toBeNull();
    expect(keysymFromEvent({ key: "" })).toBeNull();
    expect(keysymFromEvent({ key: "SomeFutureKey" })).toBeNull();
  });
});

describe("buttonCodeFromEvent", () => {
  it("maps the primary three buttons to X11 numbering", () => {
    expect(buttonCodeFromEvent(0)).toBe(1);
    expect(buttonCodeFromEvent(1)).toBe(2);
    expect(buttonCodeFromEvent(2)).toBe(3);
  });

  it("maps the side buttons above the wheel range", () => {
    expect(buttonCodeFromEvent(3)).toBe(8);
    expect(buttonCodeFromEvent(4)).toBe(9);
  });

  it("returns null for buttons with no mapping", () => {
    expect(buttonCodeFromEvent(9)).toBeNull();
  });
});
