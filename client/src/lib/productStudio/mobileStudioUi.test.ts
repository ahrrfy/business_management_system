import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  adjustStudioReviewZoom,
  defaultStudioScope,
  findScannedOwnedTask,
  mobileStudioPanel,
  toggleStudioReviewImage,
} from "./mobileStudioUi";

describe("mobile studio workflow", () => {
  it("opens the worklist appropriate to the user's role", () => {
    expect(defaultStudioScope({ canManage: false, canAudit: false })).toBe("MINE");
    expect(defaultStudioScope({ canManage: true, canAudit: false })).toBe("QUEUE");
    expect(defaultStudioScope({ canManage: false, canAudit: true })).toBe("HISTORY");
  });

  it("switches a narrow screen from the task list to one full task detail", () => {
    expect(mobileStudioPanel(null)).toBe("LIST");
    expect(mobileStudioPanel(41)).toBe("DETAIL");
  });

  it("selects only an already-owned task after scanning its product", () => {
    const tasks = [{ id: 7, productId: 12 }, { id: 9, productId: 15 }];
    expect(findScannedOwnedTask(tasks, 15)?.id).toBe(9);
    expect(findScannedOwnedTask(tasks, 30)).toBeUndefined();
  });

  it("toggles the mobile review image and bounds zoom controls", () => {
    expect(toggleStudioReviewImage("candidate")).toBe("original");
    expect(toggleStudioReviewImage("original")).toBe("candidate");
    expect(adjustStudioReviewZoom(1, "in")).toBe(1.25);
    expect(adjustStudioReviewZoom(3, "in")).toBe(3);
    expect(adjustStudioReviewZoom(0.5, "out")).toBe(0.5);
  });

  /**
   * ⚠️ **حدُّ هذا الاختبار:** يقرأ **نصّ الملفات** ولا يُصيّر شيئاً — فهو شبكةُ ارتدادٍ على
   * رموزٍ في الشيفرة، لا دليلٌ على أنّ زرّاً يظهر أو لا يحجبه شيء. مرورُه أخضرَ يتعايش مع
   * شاشةٍ مكسورة تماماً. لا تُعامله كإثباتٍ بصريّ ولا تُوسّعه؛ المنطق القابل للاختبار
   * فعلاً يُستخرَج إلى هذا الملف ويُختبَر كالدوالّ أعلاه.
   */
  it("markup regression net: key mobile tokens still present in source", () => {
    const page = readFileSync(new URL("../../pages/ProductImageStudio.tsx", import.meta.url), "utf8");
    const uploader = readFileSync(new URL("../../components/form/ImageUploader.tsx", import.meta.url), "utf8");
    const picker = readFileSync(new URL("../../components/product-studio/StudioProductPicker.tsx", import.meta.url), "utf8");

    expect(page).toContain("عودة إلى المهام");
    expect(page).toContain("fixed bottom-24");
    expect(page.match(/sticky bottom-24[^\n]*mt-16/g)).toHaveLength(2);
    expect(page).toContain("الصورة الأصلية");
    expect(page).toContain("المرشّح");
    expect(page).toContain("تكبير الصورة");
    expect(page).toContain("STUDIO_REJECTION_PRESETS");
    expect(page).toContain("bulkAssign.mutate");
    expect(page).toContain("إسناد ${bulkProductIds.length} مهام");
    expect(page).toContain("studio-task-priority-filter");
    expect(page).toContain("studio-due-at");
    expect(page).toContain("studio-selected-due-at");
    expect(page).toContain("updateSchedule.mutate");
    expect(page).toContain("المتأخرة فقط");
    expect(page).toContain("وسيط زمن الدورة");
    expect(page).toContain("expectedRevision: selected.revision");
    expect(uploader).toContain("التقاط بالكاميرا الخلفية");
    expect(uploader).toContain("اختيار من المعرض");
    expect(uploader).toContain("إعادة الالتقاط");
    expect(uploader).toContain("معالجة في الاستوديو");
    expect(uploader).toContain("min-h-11");
    expect(uploader).not.toContain("group-hover:opacity-100");
    expect(picker).toContain("const CameraScanner = lazy");
    expect(picker).not.toContain('import { CameraScanner }');
  });
});
