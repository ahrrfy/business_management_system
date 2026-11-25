import { describe, expect, it } from "vitest";
import {
  customizerObjectPrefix,
  customizerObjectRoot,
  imageStoreTenantPrefix,
  isCurrentTenantCandidateKey,
  isCurrentTenantCustomizerKey,
  studioObjectPrefix,
  studioObjectRoot,
} from "../tenantNamespace";

describe("image store single-company namespace", () => {
  it("always uses the stable single prefix for Studio and customizer objects", () => {
    expect(imageStoreTenantPrefix()).toBe("single");
    expect(studioObjectRoot()).toBe("single/studio/");
    expect(studioObjectPrefix("candidate")).toBe("single/studio/candidate");
    expect(studioObjectPrefix("original")).toBe("single/studio/original");
    expect(customizerObjectRoot()).toBe("single/storefront-customizer/");
    expect(customizerObjectPrefix("logo")).toBe("single/storefront-customizer/logo");
    expect(customizerObjectPrefix("preview")).toBe("single/storefront-customizer/preview");
  });

  it("validates candidate and customizer keys strictly under single/", () => {
    expect(isCurrentTenantCandidateKey("single/studio/candidate/img-1.webp")).toBe(true);
    expect(isCurrentTenantCandidateKey("company-1/studio/candidate/img-1.webp")).toBe(false);
    expect(isCurrentTenantCustomizerKey("single/storefront-customizer/logo/a.png")).toBe(true);
    expect(isCurrentTenantCustomizerKey("single/storefront-customizer/logo/../a.png")).toBe(false);
  });
});
