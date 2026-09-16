/**
 * عقودُ واجهة صفّ القرار — قراءةُ المصدر (نمط `auditedUxContracts`):
 *  · ملاحظةُ الاعتماد الاختياريّة لها مدخلٌ ظاهر («اعتماد بملاحظة») — كانت مخفيّةً والزرّ يرسل فوراً.
 *  · صيغُ الاعتماد المتعدّدة تُختار صراحةً وتُرسَل `variant`، والزرّ معطَّل بلا اختيار.
 *  · الصفُّ المحجوب يقود إلى «الشاشة الكاملة» لا إلى زرّ اعتمادٍ يكذب.
 * (Codex على #1004.)
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const row = readFileSync(new URL("./DecisionRow.tsx", import.meta.url), "utf8");

describe("DecisionRow — عقود الواجهة", () => {
  it("ملاحظة الاعتماد الاختيارية لها مدخل ظاهر قبل الارسال", () => {
    expect(row).toContain("اعتماد بملاحظة");
    expect(row).toContain('setMode("APPROVE")');
    expect(row).toContain('(mode !== "IDLE" || row.approveReason === "REQUIRED")');
  });

  it("صيغ الاعتماد تختار صراحة وترسل variant ولا اعتماد بلا اختيار", () => {
    expect(row).toContain("row.approveVariants");
    expect(row).toContain("صيغة الاعتماد");
    expect(row).toContain('variant: action === "APPROVE" && hasVariants ? variant : undefined');
    expect(row).toContain("!variantOk");
    // المنتقي الموحَّد لا `<select>` خامّ.
    expect(row).toContain("<AppSelect");
    expect(row).not.toMatch(/<select[\s>]/);
  });

  it("الصف المحجوب يقود الى الشاشة الكاملة ويخفي زر الاعتماد", () => {
    expect(row).toContain("افتح الشاشة الكاملة");
    expect(row).toContain('row.allowedActions.includes("APPROVE") && !row.approveBlockedReason');
  });
});
