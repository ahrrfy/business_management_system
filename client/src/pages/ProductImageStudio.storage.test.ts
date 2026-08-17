import { describe, expect, it } from "vitest";
import {
  isStudioStorageActionDisabled,
  STUDIO_STORAGE_DISABLED_MESSAGE,
} from "./ProductImageStudio";

describe("ProductImageStudio legacy-only storage state", () => {
  it("disables object-store actions until the dashboard explicitly reports readiness", () => {
    expect(isStudioStorageActionDisabled(undefined)).toBe(true);
    expect(isStudioStorageActionDisabled(false)).toBe(true);
    expect(isStudioStorageActionDisabled(true)).toBe(false);
  });

  it("explains that history remains readable while R2 actions are stopped", () => {
    expect(STUDIO_STORAGE_DISABLED_MESSAGE).toContain("R2");
    expect(STUDIO_STORAGE_DISABLED_MESSAGE).toContain("السجل");
  });
});
