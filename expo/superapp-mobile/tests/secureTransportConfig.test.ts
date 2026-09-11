import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const plugin = require("../plugins/withAlrueyaSecureTransport");
const { decodeAndroidConfiguration, encodeAndroidConfiguration, normalize } = plugin.__testing as {
  decodeAndroidConfiguration(value: string): string;
  encodeAndroidConfiguration(value: string): string;
  normalize(input: { environment?: string; baseUrl?: string; spkiPins?: string[] }): string;
};

describe("compiled secure transport configuration", () => {
  it("keeps the default development build as a non-live preview", () => {
    expect(JSON.parse(normalize({ environment: "development", baseUrl: "", spkiPins: [] }))).toEqual({
      environment: "development",
      baseUrl: "",
      spkiPins: [],
    });
  });

  it("rejects production HTTP and a production build without a pin", () => {
    expect(() => normalize({
      environment: "production",
      baseUrl: "http://erp.example.test",
      spkiPins: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    })).toThrow("HTTPS");
    expect(() => normalize({ environment: "production", baseUrl: "https://erp.example.test", spkiPins: [] })).toThrow("SPKI pin");
  });

  it("round-trips production configuration through the Android resource envelope", () => {
    const normalized = normalize({
      environment: "production",
      baseUrl: "https://srv1548487.hstgr.cloud",
      spkiPins: [
        "heyx24VzgigLNUK_xrMM4IODY0kLR33mjqjg_b8HUPg",
        "brzvtCELCIZUo4sD_qPX0ccRtPsd3DY6RfmxpOU9oB4",
      ],
    });
    const encoded = encodeAndroidConfiguration(normalized);

    expect(encoded).toMatch(/^base64url-v1:[A-Za-z0-9_-]+$/);
    expect(JSON.parse(decodeAndroidConfiguration(encoded))).toEqual(JSON.parse(normalized));
  });
});
