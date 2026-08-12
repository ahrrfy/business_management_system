/**
 * الشريحة ١ من خطة الدفتر المزدوج (docs/double-entry-p2-plan-2026-08-11.md): خطّاف الظلّ.
 *
 * الثوابت المُختبَرة هي بوّابات السلامة الإنتاجية — كلٌّ منها سببُ وجودِ سطرٍ في الخطّاف:
 *   س٢ الوضع OFF ⇒ صفر كتابة · س٣ **لا شيء يُفشِل عملية أعمال** · س٤ نفس المعاملة (لا قيدَ يتيم)
 *   + «لا تخمين على النواة المالية»: دلو نقدٍ ملتبس أو غائب ⇒ فجوةٌ موسومة لا تصنيفٌ خاطئ.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { postEntry } from "../ledgerService";
import { money } from "../money";
import { postOpeningEntry, upsertOpeningEntry } from "../openingBalance";
import { withTx } from "../tx";
import { truncateTables } from "./__testUtils__";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

async function reset() {
  await truncateTables([
    "journalLines",
    "journalEntries",
    "accountingEntries",
    "doubleEntrySettings",
    "customers",
    "branches",
    "users",
  ]);
}

async function seedBase(mode: "OFF" | "SHADOW" | "ACTIVE") {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.customers).values({ id: 1, name: "عميل اختبار", defaultPriceTier: "RETAIL", currentBalance: "0" });
  await d.insert(s.doubleEntrySettings).values({ id: 1, mode });
}

/** كل القيود المزدوجة مع أسطرها، بترتيب الإدراج. */
async function journals() {
  const heads = await db().select().from(s.journalEntries);
  const lines = await db().select().from(s.journalLines);
  return heads.map((h) => ({
    status: h.status,
    reason: h.unmappedReason,
    lines: lines
      .filter((l) => Number(l.journalId) === Number(h.id))
      .map((l) => ({ role: l.role, debit: Number(l.debit), credit: Number(l.credit) })),
  }));
}

beforeEach(async () => {
  await reset();
});

describe("shadowHook — خطّاف الدفتر المزدوج (ش١)", () => {
  it("١) الوضع OFF ⇒ عمليةٌ ماليّةٌ كاملة بصفر صفوفٍ مزدوجة (س٢)", async () => {
    await seedBase("OFF");
    await withTx(async (tx) => {
      await postEntry(tx, {
        entryType: "SALE",
        branchId: 1,
        customerId: 1,
        revenue: money("100.00"),
        cost: money("60.00"),
        amount: money("100.00"),
      });
    });

    expect(await journals()).toEqual([]);
    // والقيد المبسّط كُتب كالمعتاد ⇒ صفر أثرٍ على السلوك القائم.
    const entries = await db().select().from(s.accountingEntries);
    expect(entries).toHaveLength(1);
  });

  it("٢) SHADOW ⇒ بيعٌ يُنتج قيداً متوازناً (AR / مبيعات / COGS / مخزون)", async () => {
    await seedBase("SHADOW");
    await withTx(async (tx) => {
      await postEntry(tx, {
        entryType: "SALE",
        branchId: 1,
        customerId: 1,
        revenue: money("100.00"),
        cost: money("60.00"),
        amount: money("100.00"),
      });
    });

    const [j] = await journals();
    expect(j.status).toBe("POSTED");
    const dr = j.lines.reduce((a, l) => a + l.debit, 0);
    const cr = j.lines.reduce((a, l) => a + l.credit, 0);
    expect(dr).toBe(cr);
    expect(dr).toBe(160); // AR 100 + COGS 60
    expect(j.lines.find((l) => l.role === "AR")?.debit).toBe(100);
    expect(j.lines.find((l) => l.role === "SALES_STATIONERY")?.credit).toBe(100);
    expect(j.lines.find((l) => l.role === "INVENTORY")?.credit).toBe(60);
  });

  it("٣) قبضٌ بالبطاقة ⇒ CARD_BANK لا CASH (وإلّا ضُخّمت الخزينة وصُفِّر البنك)", async () => {
    await seedBase("SHADOW");
    await withTx(async (tx) => {
      await postEntry(tx, {
        entryType: "PAYMENT_IN",
        branchId: 1,
        customerId: 1,
        amount: money("75.00"),
        paymentMethod: "CARD",
      });
    });

    const [j] = await journals();
    expect(j.status).toBe("POSTED");
    expect(j.lines.find((l) => l.role === "CARD_BANK")?.debit).toBe(75);
    expect(j.lines.some((l) => l.role === "CASH")).toBe(false);
    expect(j.lines.find((l) => l.role === "AR")?.credit).toBe(75);
  });

  it("٤) رصيد اتصالات (TELECOM) ⇒ فجوةٌ موسومة لا تخمين — ليس نقداً ولا بنكاً", async () => {
    await seedBase("SHADOW");
    await withTx(async (tx) => {
      await postEntry(tx, {
        entryType: "PAYMENT_IN",
        branchId: 1,
        customerId: 1,
        amount: money("50.00"),
        paymentMethod: "TELECOM",
      });
    });

    const [j] = await journals();
    expect(j.status).toBe("UNMAPPED");
    expect(j.reason).toContain("TELECOM");
    expect(j.lines).toHaveLength(0);
  });

  it("٥) قبضٌ بلا طريقةِ دفعٍ ⇒ فجوة، لا افتراضَ نقدٍ صامت", async () => {
    await seedBase("SHADOW");
    await withTx(async (tx) => {
      await postEntry(tx, { entryType: "PAYMENT_IN", branchId: 1, customerId: 1, amount: money("30.00") });
    });

    const [j] = await journals();
    expect(j.status).toBe("UNMAPPED");
    expect(j.reason).toContain("غير مُمرَّرة");
  });

  it("٦) نوعٌ غير مُخطَّط (GIFT_OUT) ⇒ العملية تنجح والفجوة تُسجَّل (س٣ — الاختبار الحاسم)", async () => {
    await seedBase("SHADOW");
    await withTx(async (tx) => {
      await postEntry(tx, {
        entryType: "GIFT_OUT",
        branchId: 1,
        cost: money("20.00"),
        profit: money("-20.00"),
      });
    });

    // العملية المالية تمّت (لم تُرمَ رميةٌ تُسقط المعاملة).
    expect(await db().select().from(s.accountingEntries)).toHaveLength(1);
    const [j] = await journals();
    expect(j.status).toBe("UNMAPPED");
    expect(j.reason).toContain("GIFT_OUT");
  });

  it("٧) تراجُع المعاملة يتراجع معه القيد المزدوج ⇒ لا قيدَ يتيم (س٤)", async () => {
    await seedBase("SHADOW");
    await expect(
      withTx(async (tx) => {
        await postEntry(tx, {
          entryType: "SALE",
          branchId: 1,
          customerId: 1,
          revenue: money("100.00"),
          amount: money("100.00"),
        });
        throw new Error("فشلٌ متعمَّد بعد القيد");
      }),
    ).rejects.toThrow("فشلٌ متعمَّد");

    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
    expect(await journals()).toEqual([]);
  });

  it("٨) الرصيد الافتتاحيّ يُنتج قيداً مزدوجاً (يُثبت مرورَه عبر postEntry — ش٠)", async () => {
    await seedBase("SHADOW");
    await withTx(async (tx) => {
      await postOpeningEntry(tx, "CUSTOMER", 1, "500.00");
    });

    const [j] = await journals();
    expect(j.status).toBe("POSTED");
    expect(j.lines.find((l) => l.role === "AR")?.debit).toBe(500);
    expect(j.lines.find((l) => l.role === "OPENING_EQUITY")?.credit).toBe(500);
  });

  it("٩) تعديل مبلغ الرصيد الافتتاحيّ يعيد بناء القيد ⇒ لا قيدَ بائتٌ يخالف الدفتر", async () => {
    await seedBase("SHADOW");
    await withTx(async (tx) => {
      await postOpeningEntry(tx, "CUSTOMER", 1, "500.00");
    });
    await withTx(async (tx) => {
      await upsertOpeningEntry(tx, "CUSTOMER", 1, "800.00");
    });

    const all = await journals();
    expect(all).toHaveLength(1); // لا ازدواج
    expect(all[0].lines.find((l) => l.role === "AR")?.debit).toBe(800);
  });

  it("١٠) حذف الرصيد الافتتاحيّ (تصفيره) يجرف قيده المزدوج", async () => {
    await seedBase("SHADOW");
    await withTx(async (tx) => {
      await postOpeningEntry(tx, "CUSTOMER", 1, "500.00");
    });
    await withTx(async (tx) => {
      await upsertOpeningEntry(tx, "CUSTOMER", 1, "0.00");
    });

    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
    expect(await journals()).toEqual([]);
  });
});
