import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { POSTING_POLICY_HASH } from "../accounting/postingEngine";
import { ensureDefaultVoucherCategoriesInTx } from "../voucher/defaults";
import {
  approveVoucher,
  cancelVoucher,
  createVoucher,
  recentVouchersForParty,
} from "../voucherService";
import { truncateTables } from "./__testUtils__";

const maker = { userId: 2, branchId: 1, role: "manager" } as const;
const owner = { userId: 1, branchId: 1, role: "admin" } as const;
const secondOwner = { userId: 3, branchId: 1, role: "admin" } as const;
const CYCLE = "investment-voucher-test-cycle";
const OPENING_HASH = "a".repeat(64);

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

async function setMode(mode: "OFF" | "SHADOW" | "ACTIVE") {
  if (mode === "OFF") return;
  await db().insert(s.doubleEntrySettings).values(
    mode === "SHADOW"
      ? { id: 1, mode, shadowCycleId: CYCLE }
      : {
          id: 1,
          mode,
          shadowCycleId: CYCLE,
          shadowOpeningHash: OPENING_HASH,
          policyApprovalReference: "INVESTMENT-VOUCHER-POLICY",
          policyApprovalPolicyHash: POSTING_POLICY_HASH,
          policyApprovalCycleId: CYCLE,
          policyApprovalOpeningHash: OPENING_HASH,
          policyAccountantName: "محاسب اختبار الاستثمار",
          policyApprovedAt: new Date("2026-08-15T00:00:00.000Z"),
          policyApprovedBy: 1,
        },
  );
}

async function seedTreasuryCash(amount: string) {
  await db().insert(s.receipts).values({
    voucherNumber: "INIT-TREASURY-001",
    branchId: 1,
    direction: "IN",
    amount,
    paymentMethod: "CASH",
    cashBucket: "TREASURY",
    receiptStatus: "COMPLETED",
    receiptApprovalStatus: "APPROVED",
    partyType: "OTHER",
    counterpartyName: "رصيد افتتاحي خزينة",
    description: "تغذية خزينة للاختبار",
    createdById: 1,
    approvedById: 1,
    voucherDate: "2026-08-15",
  });
}

async function entriesFor(receiptId: number) {
  return db()
    .select()
    .from(s.accountingEntries)
    .where(eq(s.accountingEntries.receiptId, receiptId));
}

async function journalLinesForEntry(entryId: number) {
  const [head] = await db()
    .select()
    .from(s.journalEntries)
    .where(eq(s.journalEntries.entryId, entryId));
  expect(head).toMatchObject({ status: "POSTED" });
  return db()
    .select()
    .from(s.journalLines)
    .where(eq(s.journalLines.journalId, head!.id));
}

beforeEach(async () => {
  await truncateTables([
    "auditLogs",
    "journalLines",
    "journalEntries",
    "accountingEntries",
    "idempotencyKeys",
    "receipts",
    "doubleEntrySettings",
    "voucherCategories",
    "branches",
    "users",
  ]);

  await db().insert(s.branches).values({
    id: 1,
    name: "الفرع الرئيسي",
    code: "MAIN",
    type: "MAIN",
  });

  await db().insert(s.users).values([
    {
      id: 1,
      openId: "invest-owner",
      name: "مالك النظام",
      role: "admin",
      loginMethod: "local",
      branchId: 1,
      isOwner: true,
    },
    {
      id: 2,
      openId: "invest-maker",
      name: "محاسب الفرع",
      role: "manager",
      loginMethod: "local",
      branchId: 1,
      isOwner: false,
    },
    {
      id: 3,
      openId: "invest-second-owner",
      name: "مالك ثانٍ",
      role: "admin",
      loginMethod: "local",
      branchId: 1,
      isOwner: true,
    },
  ]);

  // بذر فئات السندات الافتراضية (بما فيها فئات الاستثمار الثلاث)
  await db().transaction(async (tx) => {
    await ensureDefaultVoucherCategoriesInTx(tx);
  });
});

describe("سندات الاستثمار والأرباح (Investment & Dividend Vouchers)", () => {
  it("بذر فئات الاستثمار الافتراضية الثلاث بنجاح وبأدوار محاسبية متطابقة", async () => {
    const allCategories = await db().select().from(s.voucherCategories);
    const byName = new Map(allCategories.map((c) => [c.name, c]));

    const principalReturn = byName.get("رد مبالغ استثمار");
    expect(principalReturn).toBeDefined();
    expect(principalReturn!.direction).toBe("OUT");
    expect(principalReturn!.postingRole).toBe("OTHER_LIABILITY");
    expect(principalReturn!.isActive).toBe(true);

    const dividendPayout = byName.get("توزيع أرباح وعوائد استثمار");
    expect(dividendPayout).toBeDefined();
    expect(dividendPayout!.direction).toBe("OUT");
    expect(dividendPayout!.postingRole).toBe("OTHER_EXPENSE");
    expect(dividendPayout!.isActive).toBe(true);

    const investmentReceipt = byName.get("استلام مبالغ استثمار");
    expect(investmentReceipt).toBeDefined();
    expect(investmentReceipt!.direction).toBe("IN");
    expect(investmentReceipt!.postingRole).toBe("OTHER_LIABILITY");
    expect(investmentReceipt!.isActive).toBe(true);
  });

  it("رد مبالغ استثمار للمستثمرة سلمى أحمد بمبلغ 400,000 د.ع نقداً يُخفّض الالتزام الاستثماري ولا يمس المصروف التشغيلي", async () => {
    await setMode("ACTIVE");
    await seedTreasuryCash("1000000.00");

    const [cat] = await db()
      .select()
      .from(s.voucherCategories)
      .where(eq(s.voucherCategories.name, "رد مبالغ استثمار"));
    expect(cat).toBeDefined();

    const voucher = await createVoucher(
      {
        voucherType: "PAYMENT",
        branchId: 1,
        amount: "400000.00",
        paymentMethod: "CASH",
        partyType: "OTHER",
        counterpartyName: "سلمى أحمد",
        description: "رد مبلغ استثمار للمستثمرة سلمى أحمد",
        referenceNumber: "INV-RETURN-400K",
        voucherCategoryId: cat.id,
        clientRequestId: "req-inv-return-400k",
      },
      maker,
    );

    expect(voucher.approvalStatus).toBe("PENDING_APPROVAL");
    expect(await entriesFor(voucher.receiptId)).toHaveLength(0);

    // الاعتماد المالي بواسطة المالك
    const approval = await approveVoucher(voucher.receiptId, owner);
    expect(approval.approvalStatus).toBe("APPROVED");

    // التحقق من القيد المزدوج المتوازن
    const [entry] = await entriesFor(voucher.receiptId);
    expect(entry).toMatchObject({
      entryType: "PAYMENT_OUT",
      postingProfile: "PAYMENT_OUT_CATEGORY",
      amount: "400000.00",
    });

    expect(entry!.postingIntentJson).toMatchObject({
      sourceComponents: {
        roleDebits: { OTHER_LIABILITY: "400000.00" },
        roleCredits: { TREASURY_CASH: "400000.00" },
      },
    });

    const lines = await journalLinesForEntry(entry!.id);
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "OTHER_LIABILITY",
          debit: "400000.00",
          credit: "0.00",
        }),
        expect.objectContaining({
          role: "TREASURY_CASH",
          debit: "0.00",
          credit: "400000.00",
        }),
      ]),
    );

    // تأكيد عدم المساس بالمصاريف التشغيلية
    const opExpenseLines = lines.filter(
      (l) => l.role === "OPERATING_EXPENSE" || l.role === "RENT" || l.role === "SALARIES",
    );
    expect(opExpenseLines).toHaveLength(0);
  });

  it("توزيع أرباح وعوائد استثمار للمستثمرة سلمى أحمد بمبلغ 400,000 د.ع عبر تحويل بنكي يُقيّد كمصروف أرباح وعوائد", async () => {
    await setMode("ACTIVE");

    const [cat] = await db()
      .select()
      .from(s.voucherCategories)
      .where(eq(s.voucherCategories.name, "توزيع أرباح وعوائد استثمار"));
    expect(cat).toBeDefined();

    const voucher = await createVoucher(
      {
        voucherType: "PAYMENT",
        branchId: 1,
        amount: "400000.00",
        paymentMethod: "TRANSFER",
        partyType: "OTHER",
        counterpartyName: "سلمى أحمد",
        description: "توزيع أرباح استثمار للمستثمرة سلمى أحمد",
        referenceNumber: "INV-DIV-400K-BANK",
        voucherCategoryId: cat.id,
        clientRequestId: "req-inv-div-400k-bank",
      },
      maker,
    );

    expect(voucher.approvalStatus).toBe("PENDING_APPROVAL");
    await approveVoucher(voucher.receiptId, owner);

    const [entry] = await entriesFor(voucher.receiptId);
    expect(entry).toMatchObject({
      entryType: "PAYMENT_OUT",
      postingProfile: "PAYMENT_OUT_CATEGORY",
      amount: "400000.00",
    });

    expect(entry!.postingIntentJson).toMatchObject({
      sourceComponents: {
        roleDebits: { OTHER_EXPENSE: "400000.00" },
        roleCredits: { CARD_BANK: "400000.00" },
      },
    });

    const lines = await journalLinesForEntry(entry!.id);
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "OTHER_EXPENSE",
          debit: "400000.00",
          credit: "0.00",
        }),
        expect.objectContaining({
          role: "CARD_BANK",
          debit: "0.00",
          credit: "400000.00",
        }),
      ]),
    );
  });

  it("استلام مبالغ استثمار من المستثمرة سلمى أحمد بمبلغ 400,000 د.ع يُثبت الالتزام المالي ويزيد النقد", async () => {
    await setMode("ACTIVE");

    const [cat] = await db()
      .select()
      .from(s.voucherCategories)
      .where(eq(s.voucherCategories.name, "استلام مبالغ استثمار"));
    expect(cat).toBeDefined();

    const voucher = await createVoucher(
      {
        voucherType: "RECEIPT",
        branchId: 1,
        amount: "400000.00",
        paymentMethod: "TRANSFER",
        partyType: "OTHER",
        counterpartyName: "سلمى أحمد",
        description: "إيداع استثماري وارد من سلمى أحمد",
        referenceNumber: "INV-IN-400K",
        voucherCategoryId: cat.id,
        clientRequestId: "req-inv-in-400k",
      },
      maker,
    );

    expect(voucher.approvalStatus).toBe("APPROVED");

    const [entry] = await entriesFor(voucher.receiptId);
    expect(entry).toMatchObject({
      entryType: "PAYMENT_IN",
      postingProfile: "PAYMENT_IN_CATEGORY",
      amount: "400000.00",
    });

    expect(entry!.postingIntentJson).toMatchObject({
      sourceComponents: {
        roleDebits: { CARD_BANK: "400000.00" },
        roleCredits: { OTHER_LIABILITY: "400000.00" },
      },
    });

    const lines = await journalLinesForEntry(entry!.id);
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "CARD_BANK",
          debit: "400000.00",
          credit: "0.00",
        }),
        expect.objectContaining({
          role: "OTHER_LIABILITY",
          debit: "0.00",
          credit: "400000.00",
        }),
      ]),
    );
  });

  it("إلغاء سند استثمار معتمد يولّد قيد عكس متوازن بدقة", async () => {
    await setMode("ACTIVE");

    const [cat] = await db()
      .select()
      .from(s.voucherCategories)
      .where(eq(s.voucherCategories.name, "رد مبالغ استثمار"));

    // استخدام TRANSFER لتفادي قيود الكاش وللتحقق من دقة القيد العكسي
    const voucher = await createVoucher(
      {
        voucherType: "PAYMENT",
        branchId: 1,
        amount: "400000.00",
        paymentMethod: "TRANSFER",
        partyType: "OTHER",
        counterpartyName: "سلمى أحمد",
        description: "رد استثمار سيُلغى",
        referenceNumber: "INV-CANCEL-TEST",
        voucherCategoryId: cat.id,
        clientRequestId: "req-inv-cancel-test",
      },
      maker,
    );

    await approveVoucher(voucher.receiptId, owner);

    // إلغاء السند
    const cancellation = await cancelVoucher(voucher.receiptId, owner);
    expect(cancellation.status).toBe("REVERSED");

    const [compensating] = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.referenceNumber, `CANCEL-VCH-${voucher.receiptId}`));
    expect(compensating).toBeDefined();

    const [reversalEntry] = await entriesFor(compensating.id);
    expect(reversalEntry).toMatchObject({
      entryType: "PAYMENT_IN",
      postingProfile: "PAYMENT_IN_CATEGORY_REVERSAL",
      amount: "400000.00",
    });

    expect(reversalEntry!.postingIntentJson).toMatchObject({
      sourceComponents: {
        roleDebits: { CARD_BANK: "400000.00" },
        roleCredits: { OTHER_LIABILITY: "400000.00" },
      },
    });

    const lines = await journalLinesForEntry(reversalEntry!.id);
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "CARD_BANK",
          debit: "400000.00",
          credit: "0.00",
        }),
        expect.objectContaining({
          role: "OTHER_LIABILITY",
          debit: "0.00",
          credit: "400000.00",
        }),
      ]),
    );
  });

  it("رفض استخدام فئة قبض في سند صرف أو العكس لحماية سلامة المحاسبة", async () => {
    const [inCat] = await db()
      .select()
      .from(s.voucherCategories)
      .where(eq(s.voucherCategories.name, "استلام مبالغ استثمار"));

    await expect(
      createVoucher(
        {
          voucherType: "PAYMENT",
          branchId: 1,
          amount: "100000.00",
          paymentMethod: "TRANSFER",
          partyType: "OTHER",
          counterpartyName: "سلمى أحمد",
          description: "صرف غير صالح بفئة قبض",
          referenceNumber: "INVALID-PAYMENT-DIR",
          voucherCategoryId: inCat.id,
          clientRequestId: "req-invalid-dir-1",
        },
        maker,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const [outCat] = await db()
      .select()
      .from(s.voucherCategories)
      .where(eq(s.voucherCategories.name, "رد مبالغ استثمار"));

    await expect(
      createVoucher(
        {
          voucherType: "RECEIPT",
          branchId: 1,
          amount: "100000.00",
          paymentMethod: "TRANSFER",
          partyType: "OTHER",
          counterpartyName: "سلمى أحمد",
          description: "قبض غير صالح بفئة صرف",
          referenceNumber: "INVALID-RECEIPT-DIR",
          voucherCategoryId: outCat.id,
          clientRequestId: "req-invalid-dir-2",
        },
        maker,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("رفض استخدام فئة استثمار معطلة (isActive: false) حتى لو كان حسابها المقابل متوافقاً", async () => {
    const [cat] = await db()
      .select()
      .from(s.voucherCategories)
      .where(eq(s.voucherCategories.name, "رد مبالغ استثمار"));
    expect(cat).toBeDefined();

    // تعطيل الفئة مؤقتاً
    await db()
      .update(s.voucherCategories)
      .set({ isActive: false })
      .where(eq(s.voucherCategories.id, cat.id));

    await expect(
      createVoucher(
        {
          voucherType: "PAYMENT",
          branchId: 1,
          amount: "100000.00",
          paymentMethod: "TRANSFER",
          partyType: "OTHER",
          counterpartyName: "سلمى أحمد",
          description: "صرف بفئة معطلة",
          referenceNumber: "DISABLED-CAT-TEST",
          voucherCategoryId: cat.id,
          clientRequestId: "req-disabled-cat-1",
        },
        maker,
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });

    // استعادة حالة التفعيل
    await db()
      .update(s.voucherCategories)
      .set({ isActive: true })
      .where(eq(s.voucherCategories.id, cat.id));
  });

  it("منع اعتماد السند من قبل غير المالكين (Four-Eyes Principle / Maker-Checker)", async () => {
    const [cat] = await db()
      .select()
      .from(s.voucherCategories)
      .where(eq(s.voucherCategories.name, "رد مبالغ استثمار"));

    const voucher = await createVoucher(
      {
        voucherType: "PAYMENT",
        branchId: 1,
        amount: "400000.00",
        paymentMethod: "TRANSFER",
        partyType: "OTHER",
        counterpartyName: "سلمى أحمد",
        description: "اختبار صلاحيات الاعتماد",
        referenceNumber: "INV-AUTH-TEST",
        voucherCategoryId: cat.id,
        clientRequestId: "req-inv-auth-test",
      },
      maker,
    );

    // المنشئ (مدير وليس مالكاً) يحاول الاعتماد بنفسه => FORBIDDEN
    await expect(
      approveVoucher(voucher.receiptId, maker),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("توزيع أرباح عبر محفظة إلكترونية (WALLET) يُقيّد بالدور المحاسبي PAYMENT_WALLET", async () => {
    await setMode("ACTIVE");

    const [cat] = await db()
      .select()
      .from(s.voucherCategories)
      .where(eq(s.voucherCategories.name, "توزيع أرباح وعوائد استثمار"));

    const voucher = await createVoucher(
      {
        voucherType: "PAYMENT",
        branchId: 1,
        amount: "400000.00",
        paymentMethod: "WALLET",
        partyType: "OTHER",
        counterpartyName: "سلمى أحمد",
        description: "دفع أرباح المستثمرة سلمى أحمد عبر محفظة زين كاش",
        referenceNumber: "INV-WALLET-400K",
        voucherCategoryId: cat.id,
        clientRequestId: "req-inv-wallet-400k",
      },
      maker,
    );

    await approveVoucher(voucher.receiptId, owner);

    const [entry] = await entriesFor(voucher.receiptId);
    expect(entry).toMatchObject({
      entryType: "PAYMENT_OUT",
      postingProfile: "PAYMENT_OUT_CATEGORY",
      amount: "400000.00",
    });

    const lines = await journalLinesForEntry(entry!.id);
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "OTHER_EXPENSE",
          debit: "400000.00",
          credit: "0.00",
        }),
        expect.objectContaining({
          role: "PAYMENT_WALLET",
          debit: "0.00",
          credit: "400000.00",
        }),
      ]),
    );
  });

  it("كشف السندات السابقة للمستثمرة (recentVouchersForParty) عبر counterpartyName للوقاية من الازدواج", async () => {
    const [cat] = await db()
      .select()
      .from(s.voucherCategories)
      .where(eq(s.voucherCategories.name, "رد مبالغ استثمار"));

    const voucher = await createVoucher(
      {
        voucherType: "PAYMENT",
        branchId: 1,
        amount: "400000.00",
        paymentMethod: "TRANSFER",
        partyType: "OTHER",
        counterpartyName: "سلمى أحمد",
        description: "سند استثمار أول لسلمى أحمد",
        referenceNumber: "INV-SALMA-RECENT-1",
        voucherCategoryId: cat.id,
        clientRequestId: "req-inv-recent-1",
      },
      maker,
    );

    const recents = await recentVouchersForParty({
      partyType: "OTHER",
      counterpartyName: "سلمى أحمد",
      branchId: 1,
      windowDays: 7,
      limit: 5,
    });

    expect(recents.length).toBeGreaterThanOrEqual(1);
    expect(recents.some((r: any) => r.id === voucher.receiptId)).toBe(true);
  });

  it("إلغاء سند استلام مبالغ استثمار (قبض) معتمد يولّد قيد عكس متوازن بدقة (PAYMENT_OUT_CATEGORY_REVERSAL)", async () => {
    await setMode("ACTIVE");

    const [cat] = await db()
      .select()
      .from(s.voucherCategories)
      .where(eq(s.voucherCategories.name, "استلام مبالغ استثمار"));

    const voucher = await createVoucher(
      {
        voucherType: "RECEIPT",
        branchId: 1,
        amount: "500000.00",
        paymentMethod: "TRANSFER",
        partyType: "OTHER",
        counterpartyName: "سلمى أحمد",
        description: "إيداع استثماري سيُلغى",
        referenceNumber: "INV-IN-CANCEL-TEST",
        voucherCategoryId: cat.id,
        clientRequestId: "req-inv-in-cancel-1",
      },
      maker,
    );

    expect(voucher.approvalStatus).toBe("APPROVED");

    // إلغاء سند القبض بواسطة المالك
    const cancellation = await cancelVoucher(voucher.receiptId, owner);
    expect(cancellation.status).toBe("REVERSED");

    const [compensating] = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.referenceNumber, `CANCEL-VCH-${voucher.receiptId}`));
    expect(compensating).toBeDefined();

    const [reversalEntry] = await entriesFor(compensating.id);
    expect(reversalEntry).toMatchObject({
      entryType: "PAYMENT_OUT",
      postingProfile: "PAYMENT_OUT_CATEGORY_REVERSAL",
      amount: "500000.00",
    });

    expect(reversalEntry!.postingIntentJson).toMatchObject({
      sourceComponents: {
        roleDebits: { OTHER_LIABILITY: "500000.00" },
        roleCredits: { CARD_BANK: "500000.00" },
      },
    });

    const lines = await journalLinesForEntry(reversalEntry!.id);
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "OTHER_LIABILITY",
          debit: "500000.00",
          credit: "0.00",
        }),
        expect.objectContaining({
          role: "CARD_BANK",
          debit: "0.00",
          credit: "500000.00",
        }),
      ]),
    );
  });

  it("اعتماد تلقائي فوري لسند صرف استثماري عندما ينشئه المالك (Owner Auto-Approval)", async () => {
    await setMode("ACTIVE");

    const [cat] = await db()
      .select()
      .from(s.voucherCategories)
      .where(eq(s.voucherCategories.name, "رد مبالغ استثمار"));

    // المالك ينشئ سند الصرف مباشرة => يعتمد فوراً دون حاجة لخطوة approve منفصلة
    const voucher = await createVoucher(
      {
        voucherType: "PAYMENT",
        branchId: 1,
        amount: "300000.00",
        paymentMethod: "TRANSFER",
        partyType: "OTHER",
        counterpartyName: "سلمى أحمد",
        description: "رد استثمار منشأ ومعتمد مباشرة من المالك",
        referenceNumber: "INV-OWNER-AUTO-APP",
        voucherCategoryId: cat.id,
        clientRequestId: "req-inv-owner-auto-1",
      },
      owner,
    );

    expect(voucher.approvalStatus).toBe("APPROVED");

    const [entry] = await entriesFor(voucher.receiptId);
    expect(entry).toMatchObject({
      entryType: "PAYMENT_OUT",
      postingProfile: "PAYMENT_OUT_CATEGORY",
      amount: "300000.00",
    });

    const lines = await journalLinesForEntry(entry!.id);
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "OTHER_LIABILITY",
          debit: "300000.00",
          credit: "0.00",
        }),
        expect.objectContaining({
          role: "CARD_BANK",
          debit: "0.00",
          credit: "300000.00",
        }),
      ]),
    );
  });

  it("صرف أرباح استثمارية عبر بطاقة بنكية (CARD) مع التحقق الصارم من cardLastFour", async () => {
    await setMode("ACTIVE");

    const [cat] = await db()
      .select()
      .from(s.voucherCategories)
      .where(eq(s.voucherCategories.name, "توزيع أرباح وعوائد استثمار"));

    // فشل إذا كانت cardLastFour مفقودة أو غير صالحة
    await expect(
      createVoucher(
        {
          voucherType: "PAYMENT",
          branchId: 1,
          amount: "150000.00",
          paymentMethod: "CARD",
          partyType: "OTHER",
          counterpartyName: "سلمى أحمد",
          description: "صرف أرباح ببطاقة بلا 4 أرقام",
          referenceNumber: "INV-CARD-INVALID",
          voucherCategoryId: cat.id,
          clientRequestId: "req-card-invalid-1",
        },
        maker,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // نجاح مع 4 أرقام
    const voucher = await createVoucher(
      {
        voucherType: "PAYMENT",
        branchId: 1,
        amount: "150000.00",
        paymentMethod: "CARD",
        partyType: "OTHER",
        counterpartyName: "سلمى أحمد",
        description: "صرف أرباح عبر بطاقة الماستركارد",
        cardLastFour: "9876",
        voucherCategoryId: cat.id,
        clientRequestId: "req-card-valid-1",
      },
      maker,
    );

    await approveVoucher(voucher.receiptId, owner);

    const [entry] = await entriesFor(voucher.receiptId);
    expect(entry).toMatchObject({
      entryType: "PAYMENT_OUT",
      postingProfile: "PAYMENT_OUT_CATEGORY",
      amount: "150000.00",
    });

    const lines = await journalLinesForEntry(entry!.id);
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "OTHER_EXPENSE",
          debit: "150000.00",
          credit: "0.00",
        }),
        expect.objectContaining({
          role: "CARD_BANK",
          debit: "0.00",
          credit: "150000.00",
        }),
      ]),
    );
  });

  it("تمايز فئات الاستثمار عن فئات الأمانات والمصروفات العامة رغم تشارك الدور المحاسبي", async () => {
    const allCategories = await db().select().from(s.voucherCategories);
    const byName = new Map(allCategories.map((c) => [c.name, c]));

    const investReturn = byName.get("رد مبالغ استثمار");
    const depositReturn = byName.get("ردّ أمانات وتأمينات");

    expect(investReturn).toBeDefined();
    expect(depositReturn).toBeDefined();
    expect(investReturn!.id).not.toBe(depositReturn!.id);
    expect(investReturn!.postingRole).toBe("OTHER_LIABILITY");
    expect(depositReturn!.postingRole).toBe("OTHER_LIABILITY");

    const investDividend = byName.get("توزيع أرباح وعوائد استثمار");
    const otherExpense = byName.get("مصروفات أخرى");

    expect(investDividend).toBeDefined();
    expect(otherExpense).toBeDefined();
    expect(investDividend!.id).not.toBe(otherExpense!.id);
    expect(investDividend!.postingRole).toBe("OTHER_EXPENSE");
    expect(otherExpense!.postingRole).toBe("OTHER_EXPENSE");
  });
});
