import { describe, expect, it } from "vitest";
import {
  COLD_OFFLINE_STUDIO_PATH,
  isColdOfflineStudioRoute,
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
});
