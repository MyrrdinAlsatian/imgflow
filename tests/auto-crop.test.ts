import { expect, test } from "vitest";
import { autoCropDefaults, planAutoCrop, reduceAspectRatio } from "../src/domain/auto-crop.ts";
import { detectForegroundBounds } from "../src/domain/foreground-bounds.ts";

test("fits padded subject bounds in an exact ratio and plans extension across image edges", () => {
  expect(
    planAutoCrop(
      { width: 100, height: 100 },
      { left: 0, top: 0, right: 40, bottom: 20 },
      { aspectRatio: reduceAspectRatio(32, 18), padding: 0.1, alignment: "center" },
    ),
  ).toEqual({
    extract: { left: 0, top: 0, width: 44, height: 24 },
    extend: { left: 4, top: 3, right: 0, bottom: 0 },
  });
});

test.each([
  ["center", 10],
  ["top", 19],
  ["bottom", 1],
] as const)("places extra vertical space with %s alignment", (alignment, top) => {
  expect(
    planAutoCrop(
      { width: 100, height: 100 },
      { left: 50, top: 20, right: 70, bottom: 24 },
      { aspectRatio: { width: 1, height: 1 }, padding: 0.1, alignment },
    ),
  ).toEqual({
    extract: { left: 48, top, width: 24, height: 24 },
    extend: { left: 0, top: 0, right: 0, bottom: 0 },
  });
});

test("fits asymmetric margins and puts all extra vertical space above a bottom-aligned subject", () => {
  expect(
    planAutoCrop(
      { width: 100, height: 100 },
      { left: 20, top: 10, right: 60, bottom: 30 },
      {
        aspectRatio: { width: 1, height: 1 },
        padding: { top: 0.2, right: 0.05, bottom: 0, left: 0.25 },
        alignment: "bottom",
      },
    ),
  ).toEqual({
    extract: { left: 10, top: 0, width: 52, height: 30 },
    extend: { left: 0, top: 22, right: 0, bottom: 0 },
  });
});

test("fails explicitly when an exact canvas would exceed the pixel limit", () => {
  expect(() =>
    planAutoCrop(
      { width: 9000, height: 7000 },
      { left: 0, top: 0, right: 9000, bottom: 7000 },
      { aspectRatio: { width: 1, height: 1 }, padding: 0, alignment: "center" },
    ),
  ).toThrow("auto-crop canvas exceeds");
});

test("retains separate significant components and connects diagonal foreground pixels", () => {
  const image = { width: 16, height: 16 };
  const pixels = new Uint8Array(image.width * image.height * 4);
  for (const [x, y] of [
    [3, 3],
    [4, 4],
    [5, 5],
    [8, 8],
    [9, 8],
    [10, 8],
    [15, 15],
  ] as const) {
    pixels[(y * image.width + x) * 4 + 3] = 255;
  }
  expect(
    detectForegroundBounds(pixels, image, { ...autoCropDefaults, minComponentAreaRatio: 0.01 }),
  ).toEqual({ left: 2, top: 2, right: 12, bottom: 10 });
  expect(
    detectForegroundBounds(pixels, image, { ...autoCropDefaults, minComponentAreaRatio: 1 }),
  ).toEqual({ left: 2, top: 2, right: 7, bottom: 7 });
  expect(
    detectForegroundBounds(pixels, image, { ...autoCropDefaults, removeArtifacts: false }),
  ).toEqual({ left: 2, top: 2, right: 16, bottom: 16 });
});

test("projects a thin subject from a reduced mask on a non-divisible image size", () => {
  const image = { width: 101, height: 65 };
  const pixels = new Uint8Array(image.width * image.height * 4);
  pixels[(64 * image.width + 100) * 4 + 3] = 15;
  expect(
    detectForegroundBounds(pixels, image, { ...autoCropDefaults, analysisResolution: 10 }),
  ).toEqual({ left: 81, top: 44, right: 101, bottom: 65 });
});
