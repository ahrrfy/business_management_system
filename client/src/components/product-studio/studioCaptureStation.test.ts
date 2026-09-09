import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const station = readFileSync(
  new URL("./StudioCaptureStation.tsx", import.meta.url),
  "utf8",
);
const page = readFileSync(
  new URL("../../pages/ProductImageStudio.tsx", import.meta.url),
  "utf8",
);
const media = readFileSync(
  new URL("../product/ProductMediaContentSection.tsx", import.meta.url),
  "utf8",
);

describe("studio capture barcode workflow", () => {
  it("closes the camera only after the server confirms the claim", () => {
    const success = station.slice(
      station.indexOf("onSuccess: (result)"),
      station.indexOf("onError: (error"),
    );
    expect(success.indexOf("setCameraOpen(false)")).toBeGreaterThan(-1);
    expect(success.indexOf("setCameraOpen(false)")).toBeLessThan(
      success.indexOf("onClaimed({"),
    );
    expect(station).toContain("لا توجد صور معتمدة لهذا المنتج بعد");
    expect(station).toContain("له ${active.approvedImages} صورة معتمدة");
  });

  it("keeps the mobile scanner open on failure and closes it after success", () => {
    const mobileSuccess = page.slice(
      page.indexOf("const mobileClaimByBarcode"),
      page.indexOf("function claimScannedBarcode"),
    );
    const detect = page.slice(
      page.indexOf("function claimScannedBarcode"),
      page.indexOf("async function submitForReview"),
    );
    expect(mobileSuccess.indexOf("setTaskScannerOpen(false)")).toBeLessThan(
      mobileSuccess.indexOf("applyStudioClaim({"),
    );
    expect(detect).not.toContain("setTaskScannerOpen(false)");
  });

  it("keeps product content outside the photographer capture role", () => {
    expect(media).toContain("captureOnly?: boolean");
    expect(media).toContain("!captureOnly && <div");
    expect(media).toContain("!captureOnly && onMarketingCopyChange");
  });
});
