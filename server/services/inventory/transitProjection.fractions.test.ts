import { describe, expect, it } from "vitest";
import { addBaseQuantityChecked, changeTransitProjection, parseTransitProjection, positiveId } from "./transitProjection";

describe("fractional material transit", () => {
  it("keeps legacy integer projections and canonical four-place fractions", () => {
    expect(parseTransitProjection({ "1": "10", "2": "1.5001" })).toEqual({ "1": "10", "2": "1.5001" });
  });

  it("adds and clears repeated tenths exactly", () => {
    let projection = {};
    for (let i = 0; i < 10; i++) projection = changeTransitProjection(projection, 1, 0.1);
    expect(projection).toEqual({ "1": "1" });
    for (let i = 0; i < 10; i++) projection = changeTransitProjection(projection, 1, -0.1);
    expect(projection).toEqual({});
  });

  it("aggregates shared material demand without binary drift", () => {
    const target = new Map<number, number>();
    for (let i = 0; i < 10; i++) addBaseQuantityChecked(target, 4, 0.1);
    expect(target.get(4)).toBe(1);
  });

  it("rejects quantity precision loss, negative transit, and fractional identifiers", () => {
    expect(() => changeTransitProjection({}, 1, 0.00001)).toThrow();
    expect(() => changeTransitProjection({ "1": "0.1" }, 1, -0.2)).toThrow();
    expect(() => positiveId(1.5)).toThrow();
    expect(() => parseTransitProjection({ "1": "01.5" })).toThrow();
    expect(() => parseTransitProjection({ "1": "1.5000" })).toThrow();
  });
});
