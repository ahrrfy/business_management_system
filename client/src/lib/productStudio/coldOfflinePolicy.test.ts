import { describe, expect, it } from "vitest";
import {
  COLD_OFFLINE_STUDIO_PATH,
  isColdOfflineStudioRoute,
  coldOfflineStudioActor,
  studioOfflineCapabilities,
} from "./coldOfflinePolicy";

describe("cold offline product studio policy", () => {
  it("allows only the exact Studio route during a cold offline boot", () => {
    expect(isColdOfflineStudioRoute(COLD_OFFLINE_STUDIO_PATH)).toBe(true);
    expect(isColdOfflineStudioRoute(`${COLD_OFFLINE_STUDIO_PATH}?tab=mine`)).toBe(
      true,
    );
    expect(isColdOfflineStudioRoute("/inventory")).toBe(false);
    expect(isColdOfflineStudioRoute("/catalog/image-studio/other")).toBe(false);
  });

  it("keeps local draft editing available without a dashboard while disabling every remote action", () => {
    expect(
      studioOfflineCapabilities({ offline: true, storageReady: undefined }),
    ).toEqual({
      canEditLocalDraft: true,
      canCallServer: false,
      canUseProviderOrStorage: false,
    });
  });

  it("denies a direct cold Studio URL until PIN, local user, and local role all match", () => {
    const profile = {
      userId: 7,
      name: "موظف الصور",
      role: "print_operator",
      branchId: 1,
      hasPin: true,
    };
    expect(
      coldOfflineStudioActor({
        pinVerified: false,
        profile,
        draftIdentityUserId: 7,
      }),
    ).toBeNull();
    expect(
      coldOfflineStudioActor({
        pinVerified: true,
        profile,
        draftIdentityUserId: 8,
      }),
    ).toBeNull();
    expect(
      coldOfflineStudioActor({
        pinVerified: true,
        profile: { ...profile, role: "cashier" },
        draftIdentityUserId: 7,
      }),
    ).toBeNull();
    expect(
      coldOfflineStudioActor({
        pinVerified: true,
        profile,
        draftIdentityUserId: 7,
      }),
    ).toEqual({ userId: 7, role: "print_operator" });
  });
});
