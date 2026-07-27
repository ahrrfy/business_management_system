// شجرة الحسابات (P0، الدفتر المزدوج) — تحقّق من الشجرة المبذورة بالهجرة 0115 والربط بالمفاهيم القائمة.
import { describe, expect, it } from "vitest";
import { chartOfAccounts, listAccounts } from "../accountsService";

describe("شجرة الحسابات (P0) — بيانات مبذورة بالهجرة 0115", () => {
  it("٣١ حساباً؛ ٢٦ مربوطاً بـsystemRole و٥ رؤوس بلا ربط", async () => {
    const all = await listAccounts();
    expect(all).toHaveLength(31);
    expect(all.filter((a) => a.systemRole != null)).toHaveLength(26);
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
