import { describe, expect, it } from "vitest";
import { assertValidImageDataUrl } from "../imageValidation";

const dataUrl = (mime: string, bytes: number[]) => `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff, 0xe0];

describe("assertValidImageDataUrl", () => {
  it("يقبل صورة مطابقة لصيغتها", () => {
    expect(() => assertValidImageDataUrl(dataUrl("image/png", PNG), 2_000_000, true)).not.toThrow();
    expect(() => assertValidImageDataUrl(dataUrl("image/jpeg", JPEG), 2_000_000, true)).not.toThrow();
  });

  it("يرفض بيانات متنكّرة أو غير Base64", () => {
    expect(() => assertValidImageDataUrl(dataUrl("image/png", JPEG), 2_000_000, true)).toThrow();
    expect(() => assertValidImageDataUrl("data:image/png;base64,ليسBase64", 2_000_000, true)).toThrow();
  });
});
