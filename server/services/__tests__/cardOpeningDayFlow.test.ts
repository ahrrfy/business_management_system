import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { getCardSummary } from "../cardAccountService";

/**
 * إنقاذٌ من شجرة `session/opening-balances` (غير الملتزمة، ٢٥/٧) — البند الوحيد الذي بقي
 * ذا قيمة بعد أن تجاوز `TREASURY_FUNDING` بقيّتها:
 *
 * **إيصال الرصيد الافتتاحيّ يُنشأ بتاريخ اليوم**، فكان يدخل عدّاد «وارد اليوم» في لوحة
 * البطاقات بمقدار الرصيد كلّه ⇒ يومُ الإدخال يُظهر حركةً يومية لم تقع، فيُخطئ المحاسب في
 * قراءة نشاط البطاقة ويطارد فرقاً لا وجود له.
 *
 * الثابت المطلوب: **الإجماليّ يشمله** (رصيدٌ قائم فعلاً) و**حركة اليوم لا تشمله**.
 */

function db() {
  const v = getDb();
  if (!v) throw new Error("DATABASE_URL not set for tests");
  return v;
}

const TABLES = ["accountingEntries", "receipts", "users", "branches"];

beforeEach(async () => {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values({ id: 1, openId: "u1", name: "مدير", role: "admin", loginMethod: "local", branchId: 1 });
});

/** إيصال بطاقة معتمَد بتاريخ اليوم؛ مع قيد OPENING إن كان افتتاحياً. */
async function cardReceipt(amount: string, opening: boolean) {
  const d = db();
  const [res] = await d.insert(s.receipts).values({
    branchId: 1, direction: "IN", amount, paymentMethod: "CARD",
    status: "COMPLETED", approvalStatus: "APPROVED", createdBy: 1,
  });
  const receiptId = Number((res as unknown as { insertId: number }).insertId);
  if (opening) {
    await d.insert(s.accountingEntries).values({
      entryType: "OPENING", branchId: 1, receiptId,
      amount, revenue: "0.00", cost: "0.00", profit: "0.00",
      entryDate: new Date(), createdBy: 1,
    });
  }
  return receiptId;
}

describe("لوحة البطاقات — الرصيد الافتتاحيّ ليس حركةَ اليوم", () => {
  it("إيصال افتتاحيّ اليوم: يدخل الإجماليّ ولا يدخل «وارد اليوم»", async () => {
    await cardReceipt("1000000.00", true);   // رصيد افتتاحيّ
    await cardReceipt("25000.00", false);    // بيعٌ حقيقيّ اليوم

    const sum = await getCardSummary({ branchId: 1 }, { role: "admin", branchId: null });
    // الحركة اليومية = البيع وحده.
    expect(sum.todayIn).toBe("25000.00");
    // والإجماليّ يشمل الافتتاحيّ — فالرصيد قائمٌ فعلاً.
    expect(sum.totalIn).toBe("1025000.00");
  });

  it("بلا إيصالٍ افتتاحيّ: حركة اليوم = الإجماليّ (لا انحدار على المسار الشائع)", async () => {
    await cardReceipt("25000.00", false);
    await cardReceipt("15000.00", false);
    const sum = await getCardSummary({ branchId: 1 }, { role: "admin", branchId: null });
    expect(sum.todayIn).toBe("40000.00");
    expect(sum.totalIn).toBe("40000.00");
  });
});
