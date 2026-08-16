import { describe, expect, it } from "vitest";
import {
  parseDisplayConfig,
  pinnedDimension,
  requestedDimension,
  resolveDisplaySize,
} from "../../../hosts/rdp-direct/display-size.js";

describe("parseDisplayConfig", () => {
  it("reads the stored JSON text", () => {
    expect(parseDisplayConfig('{"width":"1920"}')).toEqual({ width: "1920" });
  });

  it("passes an already-parsed object through", () => {
    expect(parseDisplayConfig({ width: 1280 })).toEqual({ width: 1280 });
  });

  it("treats a malformed blob as empty rather than failing the session", () => {
    expect(parseDisplayConfig("{not json")).toEqual({});
    expect(parseDisplayConfig("null")).toEqual({});
    expect(parseDisplayConfig('"a string"')).toEqual({});
  });

  it("treats nothing as empty", () => {
    expect(parseDisplayConfig(null)).toEqual({});
    expect(parseDisplayConfig(undefined)).toEqual({});
    expect(parseDisplayConfig("")).toEqual({});
  });
});

describe("pinnedDimension", () => {
  it("accepts the numbers the form stores as strings", () => {
    expect(pinnedDimension("1920")).toBe(1920);
    expect(pinnedDimension(1920)).toBe(1920);
  });

  it("reads the auto sentinel as no pinned size", () => {
    expect(pinnedDimension("auto")).toBeNull();
  });

  it("reads an empty field as no pinned size", () => {
    expect(pinnedDimension("")).toBeNull();
    expect(pinnedDimension(null)).toBeNull();
    expect(pinnedDimension(undefined)).toBeNull();
  });

  it("rejects sizes no RDP session could use", () => {
    expect(pinnedDimension("0")).toBeNull();
    expect(pinnedDimension("-800")).toBeNull();
    expect(pinnedDimension("100")).toBeNull();
    expect(pinnedDimension("99999")).toBeNull();
  });

  it("rejects text that is not a size", () => {
    expect(pinnedDimension("wide")).toBeNull();
    expect(pinnedDimension({})).toBeNull();
  });
});

describe("requestedDimension", () => {
  it("reads a positive integer", () => {
    expect(requestedDimension("1174")).toBe(1174);
  });

  it("rejects anything else", () => {
    expect(requestedDimension(null)).toBeNull();
    expect(requestedDimension("")).toBeNull();
    expect(requestedDimension("0")).toBeNull();
    expect(requestedDimension("-5")).toBeNull();
    expect(requestedDimension("abc")).toBeNull();
  });
});

describe("resolveDisplaySize", () => {
  it("uses the browser's size when the host pins nothing", () => {
    expect(
      resolveDisplaySize({
        hostConfig: null,
        requestedWidth: "1174",
        requestedHeight: "962",
      }),
    ).toEqual({ width: 1174, height: 962, pinned: false });
  });

  it("prefers the host's pinned size over the browser's", () => {
    expect(
      resolveDisplaySize({
        hostConfig: '{"width":"1920","height":"1080"}',
        requestedWidth: "1174",
        requestedHeight: "962",
      }),
    ).toEqual({ width: 1920, height: 1080, pinned: true });
  });

  it("ignores a half-pinned size rather than mixing the two sources", () => {
    // A pinned width with the window's height would be a shape the user never
    // asked for, so it falls back entirely.
    expect(
      resolveDisplaySize({
        hostConfig: '{"width":"1920"}',
        requestedWidth: "1174",
        requestedHeight: "962",
      }),
    ).toEqual({ width: 1174, height: 962, pinned: false });
  });

  it("treats auto in both fields as no pinned size", () => {
    expect(
      resolveDisplaySize({
        hostConfig: '{"width":"auto","height":"auto"}',
        requestedWidth: "1174",
        requestedHeight: "962",
      }),
    ).toEqual({ width: 1174, height: 962, pinned: false });
  });

  it("falls back to a usable default when neither source says anything", () => {
    expect(
      resolveDisplaySize({
        hostConfig: null,
        requestedWidth: null,
        requestedHeight: null,
      }),
    ).toEqual({ width: 1920, height: 1080, pinned: false });
  });

  it("does not let a broken config break the session", () => {
    expect(
      resolveDisplaySize({
        hostConfig: "{not json",
        requestedWidth: "1174",
        requestedHeight: "962",
      }),
    ).toEqual({ width: 1174, height: 962, pinned: false });
  });

  it("keeps the guacd colour-depth field from being read as a size", () => {
    expect(
      resolveDisplaySize({
        hostConfig: '{"color-depth":"32","width":"1600","height":"900"}',
        requestedWidth: "1174",
        requestedHeight: "962",
      }),
    ).toEqual({ width: 1600, height: 900, pinned: true });
  });
});
