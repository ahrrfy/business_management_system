import { describe, expect, it } from "vitest";
import {
  BinaryBitmap,
  HybridBinarizer,
  QRCodeReader,
  RGBLuminanceSource,
} from "@zxing/library";
import QRCode from "qrcode";
import { qrSvgSync } from "./qr";

describe("QR module geometry", () => {
  it("keeps a four-module white quiet zone and exact module coordinates", () => {
    const url = "https://alarabiya.online/store";
    const count = QRCode.create(url, { errorCorrectionLevel: "M" }).modules
      .size;
    const svg = qrSvgSync(url, 259);
    expect(svg).toContain(`viewBox="0 0 ${count + 8} ${count + 8}"`);
    const modules = [...svg.matchAll(/M(\d+),(\d+)h1v1h-1z/g)];
    expect(modules.length).toBeGreaterThan(0);
    expect(Math.min(...modules.map((module) => Number(module[1])))).toBe(4);
    expect(Math.min(...modules.map((module) => Number(module[2])))).toBe(4);
    const size = (count + 8) * 7;
    const pixels = new Uint8ClampedArray(size * size).fill(255);
    for (const module of modules) {
      const x = Number(module[1]) * 7,
        y = Number(module[2]) * 7;
      for (let dy = 0; dy < 7; dy++)
        for (let dx = 0; dx < 7; dx++) pixels[(y + dy) * size + x + dx] = 0;
    }
    expect(
      new QRCodeReader()
        .decode(
          new BinaryBitmap(
            new HybridBinarizer(new RGBLuminanceSource(pixels, size, size)),
          ),
        )
        .getText(),
    ).toBe(url);
  });
});
