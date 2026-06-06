import { describe, expect, it } from "vitest";
import { EscPos, imageDataToRaster } from "./escpos";

describe("EscPos encoder", () => {
  it("init = ESC @", () => {
    expect(Array.from(new EscPos().init().bytes())).toEqual([0x1b, 0x40]);
  });

  it("raster framing = GS v 0 + dimensions + data", () => {
    const bytes = Array.from(
      new EscPos().raster({ width: 8, height: 1, data: new Uint8Array([0b10101010]) }).bytes()
    );
    expect(bytes).toEqual([0x1d, 0x76, 0x30, 0x00, 1, 0, 1, 0, 0b10101010]);
  });

  it("raster width rounds up to whole bytes", () => {
    // 9px wide → 2 bytes per row
    const bytes = Array.from(
      new EscPos().raster({ width: 9, height: 1, data: new Uint8Array([0xff, 0x80]) }).bytes()
    );
    expect(bytes.slice(0, 8)).toEqual([0x1d, 0x76, 0x30, 0x00, 2, 0, 1, 0]);
  });

  it("cut = GS V B 0; feed adds line feeds", () => {
    expect(Array.from(new EscPos().feed(2).cut().bytes())).toEqual([0x0a, 0x0a, 0x1d, 0x56, 0x42, 0x00]);
  });

  it("imageDataToRaster: leftmost black pixel = MSB", () => {
    const data = new Uint8Array(8 * 4); // 8x1, all transparent/white
    data[0] = 0; data[1] = 0; data[2] = 0; data[3] = 255; // pixel 0 = opaque black
    const r = imageDataToRaster({ width: 8, height: 1, data });
    expect(Array.from(r.data)).toEqual([0x80]);
  });
});
