import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const plugin = require("../plugins/withAlrueyaSecureTransport");
const { normalize } = plugin.__testing as {
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
});
