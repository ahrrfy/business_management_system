import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const page = readFileSync(new URL("../CostWaves.tsx", import.meta.url), "utf8");
const detail = readFileSync(
  new URL(
    "../../components/costWave/CostWaveDetailDialog.tsx",
    import.meta.url,
  ),
  "utf8",
);
const columns = readFileSync(
  new URL(
    "../../components/costWave/costWaveColumns.tsx",
    import.meta.url,
  ),
  "utf8",
);
const hub = readFileSync(
  new URL("../InventoryHub.tsx", import.meta.url),
  "utf8",
);
const contract = readFileSync(
  new URL("../../../../shared/costWave.ts", import.meta.url),
  "utf8",
);
const decisionSource = readFileSync(
  new URL(
    "../../../../server/services/decisions/sources/inventory.ts",
    import.meta.url,
  ),
  "utf8",
);

describe("عقد واجهة موجات التكلفة", () => {
  it("تظهر كوحدة مستقلة بجوار موجات الأسعار مع الأقسام الأربعة", () => {
    expect(hub).toContain('value: "price-waves"');
    expect(hub).toContain('value: "cost-waves"');
    expect(page).toContain("إنشاء موجة");
    expect(page).toContain("بانتظار اعتمادي");
    expect(page).toContain("طلباتي");
    expect(page).toContain("التاريخ الكامل");
  });

  it("يعرض تفاصيل المنتج والفئة والفاعل والتاريخ واللقطات في DataTable", () => {
    for (const text of [
      "المنتج / المتغيّر",
      "الفئة",
      "التكلفة السابقة",
      "التكلفة الجديدة",
      "الكمية",
      "صاحب القرار",
      "التاريخ والوقت",
      "لقطة كل مرحلة",
      "الأصناف المستبعدة وأسبابها",
    ]) {
      expect(page + detail + columns).toContain(text);
    }
    expect(page).toContain("<DataTable");
    expect(detail).toContain("<DataTable");
    expect(page + detail).not.toMatch(/<table\b/i);
  });

  it("يطلب من الإدارة تحديد فرع المستند صراحةً", () => {
    expect(page).toContain("فرع المستند");
    expect(page).toContain("branchId");
    expect(page).not.toContain("branches.data?.[0]");
  });

  it("يستخدم منتقي المخزون نفسه ولا يشترط صلاحية إدارة الكتالوج", () => {
    expect(page).toContain("trpc.inventory.onHand.useQuery");
    expect(page).not.toContain("trpc.catalog.adminList.useQuery");
  });

  it("يمسح سبب الرفض عند تبديل الموجة أو إغلاق النافذة", () => {
    expect(detail).toContain("}, [waveId]);");
    expect(detail).toContain("function closeDialog()");
    expect(detail).toContain('setRejectionReason("")');
  });

  it("يرشح صندوق القرار في قاعدة البيانات ويفرض فتح التفاصيل قبل الاعتماد", () => {
    expect(decisionSource).toContain("branchId: scopedBranch ?? undefined");
    expect(decisionSource).toContain("approveBlockedReason");
    expect(decisionSource).toContain("COST_WAVE_MIN_REASON_LENGTH");
  });

  it("يشرح الاعتمادين والتطبيق الذري قبل الإرسال والاعتماد النهائي", () => {
    expect(page).toContain("يلزم شخصان مختلفان");
    expect(page).toContain("الكل أو لا شيء");
    expect(detail).toContain("الاعتماد الثاني والتطبيق");
    expect(detail).toContain("أي تعارض يوقف الكل");
  });

  it("يغطي التعيين والتعديل النسبي والتعديل بمبلغ ثابت بلغة واضحة", () => {
    for (const text of [
      "تعيين تكلفة ثابتة",
      "رفع التكلفة بمبلغ ثابت",
      "خفض التكلفة بمبلغ ثابت",
      "رفع التكلفة بنسبة (%)",
      "خفض التكلفة بنسبة (%)",
      "المبلغ",
      "سينتج تكلفة سالبة",
    ]) {
      expect(page + contract).toContain(text);
    }
  });
});
