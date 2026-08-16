// شجرة الحسابات (P0، الدفتر المزدوج) — تحقّق من الشجرة والربط بالمفاهيم القائمة.
// **بذرٌ ذاتيّ:** الاختبار يزرع الشجرة من `CHART_ACCOUNTS` في beforeEach (لا يعتمد على تهيئة CI —
// db:push لا يُطبّق INSERT الهجرة 0115، ومحاولة بذرٍ عبر ci-apply-extra كانت هشّة). هكذا يمرّ
// الاختبار موثوقاً حيثما وُجد الجدول. الإنتاج يُبذَر بالهجرة 0115 نفسها (SQL ثابت).
import { beforeEach, describe, expect, it } from "vitest";
import { accounts } from "../../../drizzle/schema";
import { CHART_ACCOUNTS } from "../accounting/chartSeed";
import { chartOfAccounts, listAccounts } from "../accountsService";
import { getDb } from "../../db";

beforeEach(async () => {
  const db = getDb();
  if (!db) throw new Error("chartOfAccounts.test: getDb() null — قاعدة الاختبار غير مهيّأة");
  await db.delete(accounts); // __setup__ يُفرّغه بين الاختبارات؛ نُعيد الزرع نظيفاً كلَّ مرّة.
  await db.insert(accounts).values(
    CHART_ACCOUNTS.map((a) => ({
      id: a.id,
      code: a.code,
      name: a.name,
      type: a.type,
      parentId: a.parentId,
      systemRole: a.systemRole,
      sortOrder: a.sortOrder,
    })),
  );
});

describe("شجرة الحسابات (P0) — بذرٌ ذاتيّ من CHART_ACCOUNTS", () => {
  it("يطابق البذر الحيّ؛ وكل الحسابات التفصيلية مربوطة عدا الرؤوس الخمسة", async () => {
    const all = await listAccounts();
    expect(all).toHaveLength(CHART_ACCOUNTS.length);
    expect(all.filter((a) => a.systemRole != null)).toHaveLength(
      CHART_ACCOUNTS.filter((a) => a.systemRole != null).length,
    );
    expect(all.filter((a) => a.systemRole == null)).toHaveLength(5); // الرؤوس الخمسة
  });

  it("الأدوار النظامية الحرجة موجودةٌ بأنواعها الصحيحة (الربط بالمفاهيم القائمة)", async () => {
    const byRole = new Map(
      (await listAccounts()).filter((a) => a.systemRole).map((a) => [a.systemRole!, a]),
    );
    for (const role of [
      "CASH", "CARD_BANK", "INVENTORY", "AR", "EMPLOYEE_ADVANCES", "FIXED_ASSETS",
      "AP", "CONSIGNMENT_PAYABLE", "ACCRUED_SALARY", "CAPITAL", "RETAINED_EARNINGS", "OPENING_EQUITY",
      "SALES_STATIONERY", "SALES_PRINT", "SALES_FLEX", "DELIVERY_REVENUE", "EXCHANGE_COMMISSION",
      "COGS", "SALARIES", "RENT", "UTILITIES", "OPERATING_EXPENSE", "LOSSES",
    ]) {
      expect(byRole.has(role)).toBe(true);
    }
    // الربط الصحيح للنوع المحاسبيّ.
    expect(byRole.get("AR")!.type).toBe("ASSET");
    expect(byRole.get("INVENTORY")!.type).toBe("ASSET");
    expect(byRole.get("AP")!.type).toBe("LIABILITY");
    expect(byRole.get("CONSIGNMENT_PAYABLE")!.type).toBe("LIABILITY");
    expect(byRole.get("OPENING_EQUITY")!.type).toBe("EQUITY");
    expect(byRole.get("SALES_STATIONERY")!.type).toBe("REVENUE");
    expect(byRole.get("COGS")!.type).toBe("EXPENSE");
    expect(byRole.get("LOSSES")!.type).toBe("EXPENSE");
  });

  it("الشجرة مجموعةٌ بالأنواع الخمسة بالترتيب المحاسبيّ، بأسماءٍ عربية سليمة", async () => {
    const tree = await chartOfAccounts();
    expect(tree.map((g) => g.type)).toEqual(["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"]);
    expect(tree[0].label).toBe("الأصول");
    // كل نوع فيه رأسٌ + تفاصيله.
    const assets = tree[0].rows;
    expect(assets.find((a) => a.systemRole === "INVENTORY")!.name).toBe("المخزون");
    expect(assets.find((a) => a.systemRole === "AR")!.name).toContain("ذمم العملاء");
  });
});
