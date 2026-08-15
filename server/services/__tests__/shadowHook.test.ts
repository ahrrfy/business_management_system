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
import {
  POSTING_POLICY_HASH,
  createPostingIntent,
  creditLine,
  debitLine,
} from "../accounting/postingEngine";
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
  await d
    .insert(s.branches)
    .values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values({
    id: 1,
    openId: "shadow-hook-admin",
    name: "مدير الاختبار",
    role: "admin",
    loginMethod: "local",
    branchId: 1,
  });
  await d
    .insert(s.customers)
    .values({
      id: 1,
      name: "عميل اختبار",
      defaultPriceTier: "RETAIL",
      currentBalance: "0",
    });
  await d.insert(s.doubleEntrySettings).values({
    id: 1,
    mode,
    shadowCycleId: mode === "OFF" ? null : "shadow-hook-cycle",
    ...(mode === "ACTIVE"
      ? {
          shadowOpeningHash: "a".repeat(64),
          policyApprovalReference: "SHADOW-HOOK-POLICY",
          policyApprovalPolicyHash: POSTING_POLICY_HASH,
          policyApprovalCycleId: "shadow-hook-cycle",
          policyApprovalOpeningHash: "a".repeat(64),
          policyAccountantName: "محاسب الاختبار",
          policyApprovedAt: new Date("2026-08-01T00:00:00.000Z"),
          policyApprovedBy: 1,
        }
      : {}),
  });
}

/** كل القيود المزدوجة مع أسطرها، بترتيب الإدراج. */
async function journals() {
  const heads = await db().select().from(s.journalEntries);
  const lines = await db().select().from(s.journalLines);
  return heads.map((h) => ({
    status: h.status,
    cycleId: h.cycleId,
    postingProfile: h.postingProfile,
    reason: h.unmappedReason,
    lines: lines
      .filter((l) => Number(l.journalId) === Number(h.id))
      .map((l) => ({
        role: l.role,
        debit: Number(l.debit),
        credit: Number(l.credit),
      })),
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

  it("٢) SHADOW ⇒ SALE بلا intent canonical يحفظ المصدر ويسجّل فجوة", async () => {
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
    expect(j.status).toBe("UNMAPPED");
    expect(j.reason).toContain("canonical");
    const [source] = await db().select().from(s.accountingEntries);
    expect(source).toMatchObject({
      postingCycleId: "shadow-hook-cycle",
      postingProfile: null,
      postingIntentJson: null,
      postingIntentHash: null,
    });
  });

  it("٣) SHADOW ⇒ PAYMENT_IN بلا intent canonical فجوة ولو كانت طريقة الدفع معروفة", async () => {
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
    expect(j.status).toBe("UNMAPPED");
    expect(j.reason).toContain("canonical");
    expect(j.lines).toHaveLength(0);
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
    expect(j.reason).toContain("canonical");
    expect(j.lines).toHaveLength(0);
  });

  it("٥) قبضٌ بلا طريقةِ دفعٍ ⇒ فجوة، لا افتراضَ نقدٍ صامت", async () => {
    await seedBase("SHADOW");
    await withTx(async (tx) => {
      await postEntry(tx, {
        entryType: "PAYMENT_IN",
        branchId: 1,
        customerId: 1,
        amount: money("30.00"),
      });
    });

    const [j] = await journals();
    expect(j.status).toBe("UNMAPPED");
    expect(j.reason).toContain("canonical");
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

  it("٧) ACTIVE ⇒ نقص الخريطة يفشل مغلقاً ويرجع القيد المبسّط داخل المعاملة", async () => {
    await seedBase("ACTIVE");
    await expect(
      withTx(async (tx) => {
        await postEntry(tx, {
          entryType: "GIFT_OUT",
          branchId: 1,
          cost: money("20.00"),
          profit: money("-20.00"),
        });
      }),
    ).rejects.toThrow();

    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
    expect(await journals()).toEqual([]);
  });

  it("٨) ACTIVE ⇒ بيانات دلو النقد الناقصة تفشل مغلقاً ولا تتحول إلى فجوة", async () => {
    await seedBase("ACTIVE");
    await expect(
      withTx(async (tx) => {
        await postEntry(tx, {
          entryType: "PAYMENT_IN",
          branchId: 1,
          customerId: 1,
          amount: money("30.00"),
        });
      }),
    ).rejects.toThrow();

    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
    expect(await journals()).toEqual([]);
  });

  it("٨ مكرر) ACTIVE يرفض اعتماد سياسة قديم قبل إدراج المصدر", async () => {
    await seedBase("ACTIVE");
    await db()
      .update(s.doubleEntrySettings)
      .set({ policyApprovalPolicyHash: "f".repeat(64) })
      .where(eq(s.doubleEntrySettings.id, 1));

    await expect(
      withTx(async (tx) => {
        await postEntry(tx, {
          entryType: "GIFT_OUT",
          branchId: 1,
          cost: money("20.00"),
          profit: money("-20.00"),
          postingIntent: createPostingIntent("GIFT_OUT_PROMO", "GIFT_OUT", [
            debitLine("GIFTS_PROMO", "20.00"),
            creditLine("INVENTORY", "20.00"),
          ]),
        });
      }),
    ).rejects.toThrow("اعتماد المحاسب");
    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
    expect(await journals()).toEqual([]);
  });

  it.each([
    ["دورة أخرى", { policyApprovalCycleId: "other-cycle" }],
    ["بصمة افتتاح أخرى", { policyApprovalOpeningHash: "b".repeat(64) }],
  ] as const)(
    "٨ مكرر) ACTIVE يرفض اعتماد %s قبل إدراج المصدر",
    async (_label, patch) => {
      await seedBase("ACTIVE");
      await db()
        .update(s.doubleEntrySettings)
        .set(patch)
        .where(eq(s.doubleEntrySettings.id, 1));
      await expect(
        withTx(async (tx) => {
          await postEntry(tx, {
            entryType: "GIFT_OUT",
            branchId: 1,
            cost: money("20.00"),
            profit: money("-20.00"),
            postingIntent: createPostingIntent("GIFT_OUT_PROMO", "GIFT_OUT", [
              debitLine("GIFTS_PROMO", "20.00"),
              creditLine("INVENTORY", "20.00"),
            ]),
          });
        }),
      ).rejects.toThrow("اعتماد المحاسب");
      expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
    },
  );

  it("٩) SHADOW ⇒ غياب الدليل يبقى أفضل جهد ويسجّل فجوةً مرئية", async () => {
    await seedBase("SHADOW");
    await withTx(async (tx) => {
      await postEntry(tx, {
        entryType: "SALE",
        branchId: 1,
        customerId: 1,
        revenue: money("-10.00"),
        amount: money("-10.00"),
      });
    });

    expect(await db().select().from(s.accountingEntries)).toHaveLength(1);
    const [journal] = await journals();
    expect(journal.status).toBe("UNMAPPED");
    expect(journal.reason).toContain("canonical");
  });

  it("١٠) PostingIntent يغلب الاشتقاق القديم ويحفظ profile وcycleId", async () => {
    await seedBase("SHADOW");
    await withTx(async (tx) => {
      await postEntry(tx, {
        entryType: "GIFT_OUT",
        branchId: 1,
        cost: money("20.00"),
        profit: money("-20.00"),
        postingIntent: createPostingIntent("GIFT_OUT_PROMO", "GIFT_OUT", [
          debitLine("GIFTS_PROMO", "20.00"),
          creditLine("INVENTORY", "20.00"),
        ]),
      });
    });

    const [journal] = await journals();
    expect(journal.status).toBe("POSTED");
    expect(journal.cycleId).toBe("shadow-hook-cycle");
    expect(journal.postingProfile).toBe("GIFT_OUT_PROMO");
    expect(journal.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "GIFTS_PROMO", debit: 20 }),
        expect.objectContaining({ role: "INVENTORY", credit: 20 }),
      ]),
    );
  });

  it("١١) intent القبض الصريح للمحفظة لا يمر بتخمين cashRole القديم", async () => {
    await seedBase("SHADOW");
    const sourceComponents = {
      roleDebits: { DIGITAL_WALLET: "30.00" },
      roleCredits: { AR: "30.00" },
    } as const;
    await withTx(async (tx) => {
      await postEntry(tx, {
        entryType: "PAYMENT_IN",
        branchId: 1,
        customerId: 1,
        amount: money("30.00"),
        paymentMethod: "WALLET",
        postingIntent: createPostingIntent(
          "PAYMENT_IN_CUSTOMER",
          "PAYMENT_IN",
          [
            debitLine("DIGITAL_WALLET", "30.00"),
            creditLine("AR", "30.00"),
          ],
          sourceComponents,
        ),
        postingSourceComponents: sourceComponents,
      });
    });

    const [journal] = await journals();
    expect(journal.status).toBe("POSTED");
    expect(journal.lines.find((line) => line.role === "DIGITAL_WALLET")?.debit).toBe(30);
    const [source] = await db().select().from(s.accountingEntries);
    expect(source.postingProfile).toBe("PAYMENT_IN_CUSTOMER");
    expect(source.postingIntentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(source.postingCycleId).toBe("shadow-hook-cycle");
  });

  it("١٢) DELIVERY_DISPATCH_COD يكتب رأس MEMO مرتبطاً بلا أسطر", async () => {
    await seedBase("SHADOW");
    await withTx(async (tx) => {
      await postEntry(tx, {
        entryType: "DELIVERY_DISPATCH",
        branchId: 1,
        amount: money("75.00"),
        postingIntent: createPostingIntent(
          "DELIVERY_DISPATCH_COD",
          "DELIVERY_DISPATCH",
          [],
        ),
      });
    });

    const [journal] = await journals();
    expect(journal.status).toBe("MEMO");
    expect(journal.postingProfile).toBe("DELIVERY_DISPATCH_COD");
    expect(journal.lines).toEqual([]);
  });

  it("١٣) تراجُع المعاملة يتراجع معه القيد المزدوج ⇒ لا قيدَ يتيم (س٤)", async () => {
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

  it("١٤) يمنع إنشاء مصدر OPENING جديد بعد بدء SHADOW", async () => {
    await seedBase("SHADOW");
    await expect(
      withTx(async (tx) => {
        await postOpeningEntry(tx, "CUSTOMER", 1, "500.00");
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
    expect(await journals()).toEqual([]);
  });

  it("١٥) يمنع تعديل مصدر OPENING تاريخي في SHADOW ويبقي قيمته", async () => {
    await seedBase("OFF");
    await withTx(async (tx) => {
      await postOpeningEntry(tx, "CUSTOMER", 1, "500.00");
    });
    await db()
      .update(s.doubleEntrySettings)
      .set({ mode: "SHADOW", shadowCycleId: "shadow-hook-cycle" })
      .where(eq(s.doubleEntrySettings.id, 1));
    await expect(
      withTx(async (tx) => {
        await upsertOpeningEntry(tx, "CUSTOMER", 1, "800.00");
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    const [source] = await db().select().from(s.accountingEntries);
    expect(source.amount).toBe("500.00");
    expect(await journals()).toEqual([]);
  });

  it("١٦) يمنع حذف مصدر OPENING تاريخي في ACTIVE ويبقي قيمته", async () => {
    await seedBase("OFF");
    await withTx(async (tx) => {
      await postOpeningEntry(tx, "CUSTOMER", 1, "500.00");
    });
    await db()
      .update(s.doubleEntrySettings)
      .set({
        mode: "ACTIVE",
        shadowCycleId: "shadow-hook-cycle",
        shadowOpeningHash: "a".repeat(64),
        policyApprovalReference: "SHADOW-HOOK-POLICY",
        policyApprovalPolicyHash: POSTING_POLICY_HASH,
        policyApprovalCycleId: "shadow-hook-cycle",
        policyApprovalOpeningHash: "a".repeat(64),
        policyAccountantName: "محاسب الاختبار",
        policyApprovedAt: new Date("2026-08-01T00:00:00.000Z"),
        policyApprovedBy: 1,
      })
      .where(eq(s.doubleEntrySettings.id, 1));
    await expect(
      withTx(async (tx) => {
        await upsertOpeningEntry(tx, "CUSTOMER", 1, "0.00");
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    const [source] = await db().select().from(s.accountingEntries);
    expect(source.amount).toBe("500.00");
    expect(await journals()).toEqual([]);
  });
});
