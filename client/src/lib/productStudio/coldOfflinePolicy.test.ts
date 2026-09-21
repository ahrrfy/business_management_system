import { describe, expect, it } from "vitest";
import {
  COLD_OFFLINE_STUDIO_PATH,
  isColdOfflineStudioRoute,
  coldOfflineStudioActor,
  studioOfflineProfileInput,
  shouldSkipColdStudioAuth,
  coldStudioShellCapabilities,
  shouldMountGlobalStudioTools,
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
      companyId: 17,
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
        draftIdentity: { companyId: 17, userId: 7 },
      }),
    ).toBeNull();
    expect(
      coldOfflineStudioActor({
        pinVerified: true,
        profile,
        draftIdentity: { companyId: 17, userId: 8 },
      }),
    ).toBeNull();
    expect(
      coldOfflineStudioActor({
        pinVerified: true,
        profile: { ...profile, role: "cashier" },
        draftIdentity: { companyId: 17, userId: 7 },
      }),
    ).toBeNull();
    expect(
      coldOfflineStudioActor({
        pinVerified: true,
        profile,
        draftIdentity: { companyId: 17, userId: 7 },
      }),
    ).toEqual({ companyId: 17, userId: 7, role: "print_operator" });
    expect(
      coldOfflineStudioActor({
        pinVerified: true,
        profile,
        draftIdentity: { companyId: 18, userId: 7 },
      }),
    ).toBeNull();
    expect(
      coldOfflineStudioActor({
        pinVerified: true,
        profile: { ...profile, companyId: undefined },
        draftIdentity: { companyId: 17, userId: 7 },
      }),
    ).toBeNull();
  });

  it("provisions the existing device profile from an online Studio/login identity without a PIN", () => {
    expect(
      studioOfflineProfileInput({
        id: 7,
        name: "موظف الصور",
        email: "studio@example.test",
        role: "print_operator",
        branchId: 1,
        companyId: 17,
      }),
    ).toEqual({
      id: 7,
      companyId: 17,
      name: "موظف الصور",
      role: "print_operator",
      branchId: 1,
    });
  });

  it("skips AppLayout auth only for a PIN-verified cold Studio session", () => {
    expect(
      shouldSkipColdStudioAuth({
        location: COLD_OFFLINE_STUDIO_PATH,
        offline: true,
        pinVerified: true,
        localProfile: { userId: 7, role: "print_operator" },
      }),
    ).toBe(true);
    expect(
      shouldSkipColdStudioAuth({
        location: COLD_OFFLINE_STUDIO_PATH,
        offline: true,
        pinVerified: false,
        localProfile: { userId: 7, role: "print_operator" },
      }),
    ).toBe(false);
    expect(
      shouldSkipColdStudioAuth({
        location: "/inventory",
        offline: true,
        pinVerified: true,
        localProfile: { userId: 7, role: "print_operator" },
      }),
    ).toBe(false);
  });

  it("mounts neither global search nor mobile navigation for the verified cold Studio shell", () => {
    expect(coldStudioShellCapabilities(true)).toEqual({
      mountGlobalSearch: false,
      mountMobileBottomNav: false,
      allowRemoteNavigation: false,
    });
    expect(coldStudioShellCapabilities(false)).toEqual({
      mountGlobalSearch: true,
      mountMobileBottomNav: true,
      allowRemoteNavigation: true,
    });
  });

  it("never mounts the global search/barcode surface on the cold Studio URL", () => {
    expect(
      shouldMountGlobalStudioTools({
        location: COLD_OFFLINE_STUDIO_PATH,
        offline: true,
      }),
    ).toBe(false);
    expect(
      shouldMountGlobalStudioTools({
        location: COLD_OFFLINE_STUDIO_PATH,
        offline: false,
      }),
    ).toBe(true);
  });
});
