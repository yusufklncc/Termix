/**
 * Browser KeyboardEvent → X11 keysym.
 *
 * Both publishers speak X11 keysyms on the wire, not JS key names or DOM key
 * codes, so a translation layer is unavoidable. guacamole-common-js has one but
 * loading it here would defeat the point of keeping this path free of it.
 *
 * Printable characters follow the X11 rule: Latin-1 (U+0020–U+00FF) maps to its
 * own code point, everything else to 0x01000000 + code point. Named keys come
 * from the fixed table below (values from X11's keysymdef.h).
 */

const NAMED_KEYSYMS: Record<string, number> = {
  Backspace: 0xff08,
  Tab: 0xff09,
  Enter: 0xff0d,
  Escape: 0xff1b,
  Delete: 0xffff,

  Home: 0xff50,
  ArrowLeft: 0xff51,
  ArrowUp: 0xff52,
  ArrowRight: 0xff53,
  ArrowDown: 0xff54,
  PageUp: 0xff55,
  PageDown: 0xff56,
  End: 0xff57,
  Insert: 0xff63,

  Pause: 0xff13,
  ScrollLock: 0xff14,
  PrintScreen: 0xff61,
  NumLock: 0xff7f,
  CapsLock: 0xffe5,
  ContextMenu: 0xff67,

  ShiftLeft: 0xffe1,
  ShiftRight: 0xffe2,
  ControlLeft: 0xffe3,
  ControlRight: 0xffe4,
  AltLeft: 0xffe9,
  AltRight: 0xffea,
  MetaLeft: 0xffeb,
  MetaRight: 0xffec,

  NumpadEnter: 0xff8d,
  NumpadDivide: 0xffaf,
  NumpadMultiply: 0xffaa,
  NumpadSubtract: 0xffad,
  NumpadAdd: 0xffab,
  NumpadDecimal: 0xffae,
};

/** Left/right variants are only distinguishable through event.code. */
const SIDED_KEYS = new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "Enter",
  "Divide",
  "Multiply",
  "Subtract",
  "Add",
  "Decimal",
]);

function functionKeysym(key: string): number | null {
  const match = /^F(\d{1,2})$/.exec(key);
  if (!match) return null;
  const index = Number(match[1]);
  // F1–F12 are contiguous from XK_F1; F13+ continue from XK_F13.
  if (index >= 1 && index <= 12) return 0xffbe + (index - 1);
  if (index >= 13 && index <= 35) return 0xffcd + (index - 13);
  return null;
}

/**
 * Returns the X11 keysym for a key event, or null when the key carries no
 * meaning for the remote side (dead keys, IME composition, unknown names).
 */
export function keysymFromEvent(event: {
  key: string;
  code?: string;
}): number | null {
  const { key, code } = event;

  if (!key || key === "Unidentified" || key === "Dead") return null;

  // Sided and numpad keys: event.code carries the side, event.key does not.
  if (code && (SIDED_KEYS.has(key) || code.startsWith("Numpad"))) {
    const sided = NAMED_KEYSYMS[code];
    if (sided !== undefined) return sided;
  }

  const named = NAMED_KEYSYMS[key];
  if (named !== undefined) return named;

  const fn = functionKeysym(key);
  if (fn !== null) return fn;

  // A printable key: event.key is the character it produces.
  if ([...key].length === 1) {
    const codePoint = key.codePointAt(0);
    if (codePoint === undefined) return null;
    if (codePoint >= 0x20 && codePoint <= 0xff) return codePoint;
    return 0x01000000 + codePoint;
  }

  return null;
}

/**
 * X11 button numbers. Left/middle/right are 1/2/3; the wheel occupies 4–7 and
 * the side buttons follow at 8/9.
 */
export function buttonCodeFromEvent(button: number): number | null {
  switch (button) {
    case 0:
      return 1;
    case 1:
      return 2;
    case 2:
      return 3;
    case 3:
      return 8;
    case 4:
      return 9;
    default:
      return null;
  }
}
