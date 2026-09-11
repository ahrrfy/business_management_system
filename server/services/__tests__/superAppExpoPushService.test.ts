import { describe, expect, it } from "vitest";

import {
  SuperAppExpoPushValidationError,
  buildSuperAppExpoPushPayload,
  hashSuperAppExpoPushToken,
  parseSuperAppExpoPushPayload,
  superAppExpoPushEnvironment,
  validateSuperAppExpoPushToken,
} from "../superAppPushService";

describe("Super Arabia Expo push contract", () => {
  it("accepts an Expo token without retaining it as the storage identity", () => {
    const token = "ExponentPushToken[0123456789_abcdef]";
    expect(validateSuperAppExpoPushToken(` ${token} `)).toBe(token);
    const hash = hashSuperAppExpoPushToken(token);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain(token);
    expect(() => validateSuperAppExpoPushToken("https://attacker.test/token")).toThrow(
      SuperAppExpoPushValidationError,
    );
  });

  it("maps notifications only to reviewed, non-record destinations", () => {
    expect(buildSuperAppExpoPushPayload({ kind: "PAYROLL_READY" })).toEqual({
      version: "1",
      destination: "my-day",
    });
    expect(buildSuperAppExpoPushPayload({ kind: "SESSION_EVENT" })).toEqual({
      version: "1",
      destination: "account",
    });
    expect(buildSuperAppExpoPushPayload({ kind: "UNKNOWN" })).toEqual({
      version: "1",
      destination: "center",
    });
    expect(() =>
      parseSuperAppExpoPushPayload({ version: "1", destination: "my-day", employeeId: 9 }),
    ).toThrow(SuperAppExpoPushValidationError);
    expect(() =>
      parseSuperAppExpoPushPayload({ version: "1", destination: "https://attacker.test" }),
    ).toThrow(SuperAppExpoPushValidationError);
  });

  it("uses an explicit environment and rejects a typo rather than sending to a default", () => {
    expect(superAppExpoPushEnvironment("staging")).toBe("staging");
    expect(() => superAppExpoPushEnvironment("production")).toThrow(
      "بيئة إشعارات Expo غير صالحة",
    );
  });
});
