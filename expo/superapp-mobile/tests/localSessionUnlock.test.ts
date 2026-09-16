import { beforeEach, describe, expect, it, vi } from "vitest";

import { unlockLocalSession } from "../lib/localSessionUnlock";

const localAuthentication = vi.hoisted(() => ({
  authenticateAsync: vi.fn(),
}));

vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("expo-local-authentication", () => localAuthentication);

describe("unlockLocalSession", () => {
  beforeEach(() => localAuthentication.authenticateAsync.mockReset());

  it("allows Android device credentials without biometric enrollment", async () => {
    localAuthentication.authenticateAsync.mockResolvedValue({ success: true });

    await expect(unlockLocalSession()).resolves.toBeUndefined();
    expect(localAuthentication.authenticateAsync).toHaveBeenCalledWith(expect.objectContaining({
      biometricsSecurityLevel: "strong",
      disableDeviceFallback: false,
    }));
  });

  it("returns an actionable error when no local protection exists", async () => {
    localAuthentication.authenticateAsync.mockResolvedValue({ success: false, error: "not_enrolled" });
    await expect(unlockLocalSession()).rejects.toMatchObject({ code: "E_LOCAL_PROTECTION_REQUIRED" });
  });
});
