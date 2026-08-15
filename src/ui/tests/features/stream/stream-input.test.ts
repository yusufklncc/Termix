import { describe, expect, it } from "vitest";
import { mapPointerToRemote } from "../../../features/stream/stream-input";

function videoStub(
  videoWidth: number,
  videoHeight: number,
  rect: { left: number; top: number; width: number; height: number },
) {
  return {
    videoWidth,
    videoHeight,
    getBoundingClientRect: () => rect as DOMRect,
  };
}

describe("mapPointerToRemote", () => {
  it("maps one-to-one when the element matches the stream exactly", () => {
    const video = videoStub(1920, 1080, {
      left: 0,
      top: 0,
      width: 1920,
      height: 1080,
    });
    expect(mapPointerToRemote(video, 960, 540)).toEqual({ x: 960, y: 540 });
  });

  it("scales down a stream shown at half size", () => {
    const video = videoStub(1920, 1080, {
      left: 0,
      top: 0,
      width: 960,
      height: 540,
    });
    expect(mapPointerToRemote(video, 480, 270)).toEqual({ x: 960, y: 540 });
  });

  it("accounts for the element's offset in the viewport", () => {
    const video = videoStub(1000, 1000, {
      left: 100,
      top: 50,
      width: 1000,
      height: 1000,
    });
    expect(mapPointerToRemote(video, 300, 250)).toEqual({ x: 200, y: 200 });
  });

  it("removes horizontal letterboxing when the element is wider than the stream", () => {
    // 1000x500 element, 500x500 stream: contained at 500x500, 250px bars.
    const video = videoStub(500, 500, {
      left: 0,
      top: 0,
      width: 1000,
      height: 500,
    });
    expect(mapPointerToRemote(video, 250, 0)).toEqual({ x: 0, y: 0 });
    expect(mapPointerToRemote(video, 750, 500)).toEqual({ x: 500, y: 500 });
  });

  it("returns null inside the letterbox, which has no remote position", () => {
    const video = videoStub(500, 500, {
      left: 0,
      top: 0,
      width: 1000,
      height: 500,
    });
    expect(mapPointerToRemote(video, 100, 250)).toBeNull();
    expect(mapPointerToRemote(video, 900, 250)).toBeNull();
  });

  it("returns null before the stream reports its size", () => {
    const video = videoStub(0, 0, {
      left: 0,
      top: 0,
      width: 800,
      height: 600,
    });
    expect(mapPointerToRemote(video, 10, 10)).toBeNull();
  });
});
