import { describe, expect, it } from "vitest";
import {
  APPLE_REDUCED_TRANSITION,
  APPLE_SPRING_SETTLE,
  APPLE_SPRING_SHEET,
  APPLE_SPRING_SNAPPY,
  projectMomentum,
  rubberbandOffset,
} from "../storefrontMotion";

describe("storefront Apple motion helpers", () => {
  it("uses critically damped springs (zero accidental bounce) for default UI chrome", () => {
    expect(APPLE_SPRING_SETTLE).toMatchObject({ type: "spring", bounce: 0 });
    expect(APPLE_SPRING_SNAPPY).toMatchObject({ type: "spring", bounce: 0 });
    expect(APPLE_SPRING_SHEET).toMatchObject({ type: "spring" });
    expect(APPLE_REDUCED_TRANSITION).toMatchObject({ ease: "easeOut" });
  });

  it("projects momentum exponentially using Apple WWDC decay formula", () => {
    expect(projectMomentum(0)).toBe(0);
    expect(projectMomentum(1000, 0.99)).toBeCloseTo(99, 5);
    expect(projectMomentum(-500, 0.99)).toBeCloseTo(-49.5, 5);
  });

  it("applies progressive rubber-band resistance bounded below the dimension", () => {
    const smallPull = rubberbandOffset(20, 400);
    const largePull = rubberbandOffset(400, 400);
    expect(smallPull).toBeGreaterThan(0);
    expect(smallPull).toBeLessThan(20);
    expect(largePull).toBeGreaterThan(smallPull);
    expect(largePull).toBeLessThan(400);
  });
});
