/**
 * اختبارات وحدة «الصيرفة» (exchange-house) — السلامة المالية ثنائية العملة:
 *  1) CRUD + رصيد افتتاحي + حماية تعطيل صيرفة برصيد.
 *  2) إيداع (الخزينة ↓ عبر receipt OUT، محفظة الدينار ↑) — نقل أصل.
 *  3) شراء دولار (نموذج الدَّين، قرار مالك ٣/٨): الصيرفة تُسلِّم الدولار فوراً ⇒ WAVG صحيح لدَينٍ
 *     دولاريّ متعمّق (balanceUsd↓)، والدينار لا يُمسّ إطلاقاً.
 *  4) تسديد مورد بالدولار: محفظة الدولار ↓ + دين المورد ↓ + فرق صرف محقَّق + عمولة مصروف،
 *     **والخزينة لا تتأثّر** (سند EXCHANGE غير خزيني) — أهمّ ثابت محاسبي.
 *  5) المكشوف (سحب/شراء/تسديد) يُسمح به بتأكيد صريح — يُطلَب مرّةً واحدة فقط عند أوّل عبورٍ من
 *     رصيدٍ غير سالب إلى سالب، لا عند كل عملية تُعمِّق دَيناً قائماً أصلاً (دَينٌ متجدّد طبيعي).
 *  6) كشف الحساب + المطابقة.
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  approveExchangeDeposit,
  buyUsdAtExchange,
  createExchangeHouse,
  depositToExchange as createExchangeDepositRequest,
  getExchangeHouse,
  getExchangeStatement,
  listPendingExchangeDeposits,
  reconcileExchange,
  reverseExchangeTransaction,
  setExchangeActive,
  settleSupplierViaExchange,
  withdrawFromExchange,
} from "../exchangeHouseService";
import { getFinancialPosition, getProfitAndLoss } from "../reportsFinancialService";
import { reconcileSupplierBalances } from "../reconcileService";
import { withTx } from "../tx";
import { assertCashOutAvailable, lockCashSourceForUpdate } from "../cash/cashAvailability";
import { getCashFlowSeries } from "../treasury/cashFlow";
import { getPaymentMethodBreakdown } from "../treasury/paymentBreakdown";
import { utcTodayStart } from "../businessDay";
import { createVoucher } from "../voucher/create";
import { approveVoucher } from "../voucher/approval";
import { deriveForeignCashUsdPosition } from "../exchange/reverse";
import { POSTING_POLICY_HASH } from "../accounting/postingEngine";

const TABLES = [
  "journalLines",
  "journalEntries",
  "doubleEntrySettings",
  "accountingEntries",
  "exchangeTransactions",
  "exchangeHouses",
  "receipts",
  "idempotencyKeys",
  "suppliers",
  "branches",
  "users",
];

const actor = { userId: 1, branchId: 1, role: "manager" } as const;
// مديرٌ ثانٍ لفصل المهام (SOD) — معتمِد إيداعات الدولار (userId 2 مبذور في seed()).
const actorB = { userId: 2, branchId: 1, role: "manager" } as const;
const actorBranch2 = { userId: 3, branchId: 2, role: "manager" } as const;
const actorBranch2B = { userId: 4, branchId: 2, role: "manager" } as const;

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "local_mgr", name: "مدير", email: "m@t.test", role: "manager", loginMethod: "local", branchId: 1, isOwner: false },
    { id: 2, openId: "local_mgr2", name: "مدير ٢", email: "m2@t.test", role: "manager", loginMethod: "local", branchId: 1, isOwner: true, isActive: true },
    { id: 3, openId: "local_branch2_mgr", name: "مدير المبيعات", email: "m3@t.test", role: "manager", loginMethod: "local", branchId: 2, isOwner: false, isActive: true },
    { id: 4, openId: "local_branch2_mgr2", name: "مدير المبيعات ٢", email: "m4@t.test", role: "manager", loginMethod: "local", branchId: 2, isOwner: false, isActive: true },
  ]);
  // مورد نَدين له ٢٬٠٠٠٬٠٠٠ د.ع (AP موجب = علينا).
  await d.insert(s.suppliers).values([{ id: 1, name: "مورد الورق", currentBalance: "2000000.00" }]);
  await d.insert(s.receipts).values({
    branchId: 1,
    direction: "IN",
    amount: "10000000.00",
    paymentMethod: "CASH",
    cashBucket: "TREASURY",
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    partyType: "OTHER",
    description: "رصيد خزينة اختباري موثق",
    createdBy: 1,
  });
}

/** رصيد خزينة الفرع (نقد فعلي) = Σ(IN − OUT) على receipts TREASURY المكتملة. */
async function treasuryBalance(branchId: number): Promise<string> {
  const rows: any = await db().execute(sql`
    SELECT CAST(COALESCE(SUM(CASE WHEN direction='IN' THEN amount ELSE -amount END),0) AS CHAR) AS bal
    FROM receipts WHERE branchId=${branchId} AND cashBucket='TREASURY'
      AND receiptStatus IN ('COMPLETED', 'REVERSED') AND receiptApprovalStatus='APPROVED'`);
  const r = Array.isArray(rows) ? rows[0]?.[0] : rows?.rows?.[0];
  return String(r?.bal ?? "0");
}

async function ledgerAmount(entryType: string, exchangeHouseId: number): Promise<string> {
  const rows: any = await db().execute(sql`
    SELECT CAST(COALESCE(SUM(amount),0) AS CHAR) AS a FROM accountingEntries
    WHERE entryType=${entryType} AND exchangeHouseId=${exchangeHouseId}`);
  const r = Array.isArray(rows) ? rows[0]?.[0] : rows?.rows?.[0];
  return String(r?.a ?? "0");
}

// إيداع الدولار المباشر صار SOD (تدقيق ٢٥/٧): يُنشأ معلّقاً ثم يعتمده مديرٌ ثانٍ. مساعدٌ يجمع الخطوتين
// للاختبارات التي تفترض دولاراً نافذاً في المحفظة (المُنشئ actor، المعتمِد actorB — فصل مهام).
async function depositUsdApproved(input: Parameters<typeof depositToExchange>[0], creator = actor, approver = actorB) {
  const res = await depositToExchange(input, creator);
  await approveExchangeDeposit(res.txnId, approver);
  return res;
}

/** غالبية اختبارات السجل تفترض إيداع IQD نافذاً؛ يجمع الطلب واعتماد المالك مع إبقاء اختبار العقد منفصلاً. */
async function depositToExchange(
  input: Parameters<typeof createExchangeDepositRequest>[0],
  creator: Parameters<typeof createExchangeDepositRequest>[1],
) {
  const res = await createExchangeDepositRequest(input, creator);
  if ((input.currency ?? "IQD") === "IQD") {
    const [txn] = await db().select().from(s.exchangeTransactions).where(eq(s.exchangeTransactions.id, res.txnId));
    await approveVoucher(Number(txn.receiptId), actorB);
  }
  return res;
}

describe("exchange-house — وحدة الصيرفة ثنائية العملة", () => {
  it("لا يسمح بإيداع دينار في الصيرفة إذا لم يوجد نقد فعلي في الخزينة", async () => {
    await db().delete(s.receipts);
    const { id } = await createExchangeHouse({ name: "صيرفة بلا تمويل" }, actor);

    const request = await createExchangeDepositRequest({ exchangeHouseId: id, branchId: 1, amount: "750000" }, actor);
    const [txn] = await db().select().from(s.exchangeTransactions).where(eq(s.exchangeTransactions.id, request.txnId));
    await expect(approveVoucher(Number(txn.receiptId), actorB)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(txn).toMatchObject({ status: "PENDING_APPROVAL", balanceIqdAfter: "0.00" });

    const house = await getExchangeHouse(id);
    expect(house?.balanceIqd).toBe("0.00");
    expect(await treasuryBalance(1)).toBe("0.00");
  });

  beforeEach(async () => {
    await reset();
    await seed();
  });

  it("CRUD + رصيد افتتاحي ديناري + دولاري + حماية التعطيل", async () => {
    const { id } = await createExchangeHouse(
      { name: "صيرفة الرشيد", phone: "+9647700000000", openingBalanceIqd: "500000", openingBalanceUsd: "100", openingUsdRate: "1450" },
      actor,
    );
    const h = await getExchangeHouse(id);
    expect(h?.name).toBe("صيرفة الرشيد");
    expect(h?.balanceIqd).toBe("500000.00");
    expect(h?.balanceUsd).toBe("100.00");
    expect(h?.usdCostRate).toBe("1450.0000");

    // قيد OPENING بقيمة دينارية معادِلة = 500000 + 100×1450 = 645000.
    expect(await ledgerAmount("OPENING", id)).toBe("645000.00");

    // تعطيل صيرفة برصيد ≠ 0 ممنوع.
    await expect(setExchangeActive(id, false, actor)).rejects.toThrow();
  });

  it("إيداع: الخزينة ↓ ومحفظة الدينار ↑ (نقل أصل، قيد 0/0/0)", async () => {
    const { id } = await createExchangeHouse({ name: "صيرفة" }, actor);
    const request = await createExchangeDepositRequest({ exchangeHouseId: id, branchId: 1, amount: "2000000" }, actor);

    expect(request.pendingApproval).toBe(true);
    expect((await getExchangeHouse(id))?.balanceIqd).toBe("0.00");
    expect(await treasuryBalance(1)).toBe("10000000.00");
    expect(await ledgerAmount("EXCHANGE_DEPOSIT", id)).toBe("0.00");
    const [pendingTxn] = await db().select().from(s.exchangeTransactions).where(eq(s.exchangeTransactions.id, request.txnId));
    const [pendingReceipt] = await db().select().from(s.receipts).where(eq(s.receipts.id, Number(pendingTxn.receiptId)));
    expect(pendingReceipt).toMatchObject({ status: "PENDING", approvalStatus: "PENDING_APPROVAL", cashBucket: null });
    const statementWhilePending = await getExchangeStatement({ exchangeHouseId: id });
    expect(statementWhilePending?.transactions).toHaveLength(1); // يبقى ظاهراً للتدقيق
    expect(statementWhilePending?.summary.totalDepositIqd).toBe("0.00"); // لكنه غير نافذ بعد

    const trustedPayload = pendingReceipt.internalNote;
    await db().update(s.receipts)
      .set({ internalNote: '@SYSTEM_PAYMENT_REQUEST:{"kind":"EXCHANGE_IQD_DEPOSIT"}' })
      .where(eq(s.receipts.id, Number(pendingTxn.receiptId)));
    await expect(approveVoucher(Number(pendingTxn.receiptId), actorB)).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await getExchangeHouse(id))?.balanceIqd).toBe("0.00");
    await db().update(s.receipts).set({ internalNote: trustedPayload }).where(eq(s.receipts.id, Number(pendingTxn.receiptId)));
    await db().update(s.exchangeTransactions).set({ iqdAmount: "2000001.00" }).where(eq(s.exchangeTransactions.id, request.txnId));
    await expect(approveVoucher(Number(pendingTxn.receiptId), actorB)).rejects.toMatchObject({ code: "CONFLICT" });
    await db().update(s.exchangeTransactions).set({ iqdAmount: "2000000.00" }).where(eq(s.exchangeTransactions.id, request.txnId));

    await approveVoucher(Number(pendingTxn.receiptId), actorB);
    await approveVoucher(Number(pendingTxn.receiptId), actorB); // retry idempotent

    const h = await getExchangeHouse(id);
    expect(h?.balanceIqd).toBe("2000000.00");
    // نقد فعلي غادر الخزينة (receipt OUT).
    expect(await treasuryBalance(1)).toBe("8000000.00");
    expect(await ledgerAmount("EXCHANGE_DEPOSIT", id)).toBe("2000000.00");
    expect((await getExchangeStatement({ exchangeHouseId: id }))?.summary.totalDepositIqd).toBe("2000000.00");
  });

  it("شراء دولار (نموذج الدَّين، قرار مالك ٣/٨): الصيرفة تُسلِّم الدولار فوراً ⇒ دَينٌ دولاريّ، الدينار لا يُمسّ، WAVG صحيح", async () => {
    const { id } = await createExchangeHouse({ name: "صيرفة" }, actor);

    // أوّل شراء يعبر من رصيدٍ صفريّ (غير سالب) إلى سالب ⇒ يلزم تأكيد التجاوز.
    await expect(
      buyUsdAtExchange({ exchangeHouseId: id, branchId: 1, usdAmount: "1000", exchangeRate: "1400" }, actor),
    ).rejects.toThrow();

    const r1 = await buyUsdAtExchange({ exchangeHouseId: id, branchId: 1, usdAmount: "1000", exchangeRate: "1400", confirmNegative: true }, actor);
    expect(r1.newRate).toBe("1400.0000");
    let h = await getExchangeHouse(id);
    expect(h?.balanceUsd).toBe("-1000.00"); // دَينٌ دولاريّ للصيرفة، لا أصلٌ مملوك
    expect(h?.balanceIqd).toBe("0.00"); // لا يُمسّ إطلاقاً — لا تحويل داخل محفظة

    // شراء ٥٠٠$ إضافية بسعر ١٤٦٠ — الرصيد سالبٌ أصلاً ⇒ بلا حاجة لتأكيدٍ إضافي (تعميق دَينٍ قائم لا عبور جديد).
    // WAVG = (1000×1400 + 500×1460)/1500 = 2,130,000/1500 = 1420 (نفس حساب الترجيح، بإشارة الدَّين).
    const r2 = await buyUsdAtExchange({ exchangeHouseId: id, branchId: 1, usdAmount: "500", exchangeRate: "1460" }, actor);
    expect(r2.newRate).toBe("1420.0000");
    h = await getExchangeHouse(id);
    expect(h?.balanceUsd).toBe("-1500.00");
    expect(h?.balanceIqd).toBe("0.00");
  });

  it("تسديد مورد بالدولار: المحفظة ودين المورد ينخفضان + فرق صرف + عمولة، والخزينة لا تتأثّر", async () => {
    const { id } = await createExchangeHouse({ name: "صيرفة" }, actor);
    await depositToExchange({ exchangeHouseId: id, branchId: 1, amount: "2000000" }, actor);
    await buyUsdAtExchange({ exchangeHouseId: id, branchId: 1, usdAmount: "1000", exchangeRate: "1400", confirmNegative: true }, actor);

    const treasuryBefore = await treasuryBalance(1); // = -2,000,000 (الإيداع فقط)

    // تسديد: ٩٠٠$ من المحفظة لإطفاء دين ١٬٣٠٠٬٠٠٠ د.ع + عمولة ١٠$.
    const res = await settleSupplierViaExchange(
      { exchangeHouseId: id, branchId: 1, supplierId: 1, currency: "USD", walletAmount: "900", settledIqd: "1300000", commission: "10" },
      actor,
    );
    // فرق الصرف = 1,300,000 − (900×1400=1,260,000) = +40,000 (مكسب).
    expect(res.fxDiff).toBe("40000.00");
    expect(res.receiptId).toBeTypeOf("number");
    expect(res.voucherNumber).toMatch(/^PV-1-\d{8}-\d{5}$/);

    const h = await getExchangeHouse(id);
    expect(h?.balanceUsd).toBe("-1910.00"); // -1000 − (900 + 10) — تعميق الدَّين الدولاري
    expect(h?.balanceIqd).toBe("2000000.00"); // لم يتأثّر إطلاقاً (لا الشراء ولا التسديد بالدولار يمسّان الدينار)

    // دين المورد انخفض بمقدار المُسوّى فقط (1,300,000): 2,000,000 → 700,000.
    const sup = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)).limit(1))[0];
    expect(sup?.currentBalance).toBe("700000.00");

    // ⭐ الخزينة لم تتغيّر بالتسديد (النقد غادر عند الإيداع) — لا ازدواج خصم نقد.
    expect(await treasuryBalance(1)).toBe(treasuryBefore);
    const [voucher] = await db().select().from(s.receipts).where(eq(s.receipts.id, Number(res.receiptId)));
    expect(voucher).toMatchObject({ paymentMethod: "EXCHANGE", direction: "OUT", amount: "1300000.00", partyType: "SUPPLIER", partyId: 1, referenceNumber: res.txnNumber, status: "COMPLETED" });
    expect(voucher.signatureHash).toMatch(/^[a-f0-9]{64}$/);
    const [txn] = await db().select().from(s.exchangeTransactions).where(eq(s.exchangeTransactions.id, res.txnId));
    expect(Number(txn.receiptId)).toBe(res.receiptId);
    const [settleEntry] = await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.dedupeKey, `EXSET:${res.txnNumber}`));
    expect(Number(settleEntry.receiptId)).toBe(res.receiptId);

    // القيود: تسديد + فرق صرف + عمولة (10×1400=14,000).
    expect(await ledgerAmount("EXCHANGE_SETTLE", id)).toBe("1300000.00");
    expect(await ledgerAmount("EXCHANGE_FX_DIFF", id)).toBe("40000.00");
    expect(await ledgerAmount("EXCHANGE_FEE", id)).toBe("14000.00");
  });

  it("عكس اقتناء دولار استهلكته تسويةٌ لاحقة يُرفض (حارس اتساق فرق الصرف المحقَّق)", async () => {
    const actorB = { userId: 2, branchId: 1, role: "manager" as const };
    const { id } = await createExchangeHouse({ name: "صيرفة" }, actor);
    await depositToExchange({ exchangeHouseId: id, branchId: 1, amount: "2000000" }, actor);
    await buyUsdAtExchange({ exchangeHouseId: id, branchId: 1, usdAmount: "1000", exchangeRate: "1400", confirmNegative: true }, actor);
    // تسويةٌ لاحقة تستهلك ٩٠٠$ من دولار الاقتناء (تُرحِّل EXCHANGE_FX_DIFF على WAVG وقتها).
    await settleSupplierViaExchange(
      { exchangeHouseId: id, branchId: 1, supplierId: 1, currency: "USD", walletAmount: "900", settledIqd: "1300000", commission: "10" },
      actor,
    );

    const buyTxnId = Number((await db().select({ id: s.exchangeTransactions.id }).from(s.exchangeTransactions)
      .where(and(eq(s.exchangeTransactions.exchangeHouseId, id), eq(s.exchangeTransactions.type, "FX_BUY"))).limit(1))[0]!.id);
    const settleTxnId = Number((await db().select({ id: s.exchangeTransactions.id }).from(s.exchangeTransactions)
      .where(and(eq(s.exchangeTransactions.exchangeHouseId, id), eq(s.exchangeTransactions.type, "SETTLE"))).limit(1))[0]!.id);

    // عكس الاقتناء والتسوية اللاحقة استهلكت دولاره ⇒ يُرفض (كان يترك فرق الصرف المحقَّق على قيمةٍ بطَلت).
    await expect(reverseExchangeTransaction(buyTxnId, actorB)).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // بالترتيب الصحيح (التسوية أوّلاً ثم الاقتناء) يُسمح.
    await reverseExchangeTransaction(settleTxnId, actorB);
    const rev = await reverseExchangeTransaction(buyTxnId, actorB);
    expect(rev.status).toBe("REVERSED");
  });

  it("تسديد بالدينار: دين المورد والمحفظة الدينارية ينخفضان بلا فرق صرف", async () => {
    const { id } = await createExchangeHouse({ name: "صيرفة" }, actor);
    await depositToExchange({ exchangeHouseId: id, branchId: 1, amount: "2000000" }, actor);

    const res = await settleSupplierViaExchange(
      { exchangeHouseId: id, branchId: 1, supplierId: 1, currency: "IQD", walletAmount: "1500000", settledIqd: "1500000", commission: "5000" },
      actor,
    );
    expect(res.fxDiff).toBe("0.00");
    const h = await getExchangeHouse(id);
    expect(h?.balanceIqd).toBe("495000.00"); // 2,000,000 − (1,500,000 + 5,000)
    const sup = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)).limit(1))[0];
    expect(sup?.currentBalance).toBe("500000.00");
    expect(await ledgerAmount("EXCHANGE_FEE", id)).toBe("5000.00");
  });

  it("سحب يتجاوز الرصيد (قرار مالك ٣/٨): يُرفض بلا تأكيد، ويُقبَل بتأكيد التجاوز (دَينٌ للصيرفة)، وتعميقه لاحقاً بلا تأكيدٍ إضافي", async () => {
    const { id } = await createExchangeHouse({ name: "صيرفة" }, actor);
    await depositToExchange({ exchangeHouseId: id, branchId: 1, amount: "100000" }, actor);

    await expect(
      withdrawFromExchange({ exchangeHouseId: id, branchId: 1, amount: "150000" }, actor),
    ).rejects.toThrow();
    let h = await getExchangeHouse(id);
    expect(h?.balanceIqd).toBe("100000.00"); // لم يتغيّر بعد الرفض

    await withdrawFromExchange({ exchangeHouseId: id, branchId: 1, amount: "150000", confirmNegative: true }, actor);
    h = await getExchangeHouse(id);
    expect(h?.balanceIqd).toBe("-50000.00"); // 100,000 − 150,000 (دَينٌ علينا للصيرفة)

    // سحبٌ إضافي بعد الدخول بالسالب: تعميق دَينٍ قائم لا عبور جديد ⇒ بلا حاجة لتأكيدٍ.
    await withdrawFromExchange({ exchangeHouseId: id, branchId: 1, amount: "20000" }, actor);
    h = await getExchangeHouse(id);
    expect(h?.balanceIqd).toBe("-70000.00");
  });

  it("idempotency: إيداع بنفس clientRequestId لا يُكرّر", async () => {
    const { id } = await createExchangeHouse({ name: "صيرفة" }, actor);
    const a = await depositToExchange({ exchangeHouseId: id, branchId: 1, amount: "100000", clientRequestId: "dep-1" }, actor);
    const b = await depositToExchange({ exchangeHouseId: id, branchId: 1, amount: "100000", clientRequestId: "dep-1" }, actor);
    expect(b.txnId).toBe(a.txnId);
    const h = await getExchangeHouse(id);
    expect(h?.balanceIqd).toBe("100000.00"); // مرّة واحدة لا مرّتين
  });

  it("كشف الحساب + المطابقة: رصيد جارٍ ومطابقة بتاريخ القطع", async () => {
    const { id } = await createExchangeHouse({ name: "صيرفة" }, actor);
    await depositToExchange({ exchangeHouseId: id, branchId: 1, amount: "1000000" }, actor);
    await buyUsdAtExchange({ exchangeHouseId: id, branchId: 1, usdAmount: "500", exchangeRate: "1400", confirmNegative: true }, actor);

    const st = await getExchangeStatement({ exchangeHouseId: id });
    expect(st?.transactions.length).toBe(2);
    expect(st?.summary.currentBalanceIqd).toBe("1000000.00"); // الشراء لا يمسّ الدينار إطلاقاً
    expect(st?.summary.currentBalanceUsd).toBe("-500.00"); // دَينٌ دولاريّ (الصيرفة سلَّمته فوراً)

    // مطابقة: رصيدنا 1,000,000 د.ع / -500$ مقابل ما يقوله الصرّاف.
    const rec = await reconcileExchange({ exchangeHouseId: id, statedBalanceIqd: "1000000", statedBalanceUsd: "-500" });
    expect(rec?.matched).toBe(true);
    expect(rec?.diffIqd).toBe("0.00");

    const rec2 = await reconcileExchange({ exchangeHouseId: id, statedBalanceIqd: "950000", statedBalanceUsd: "-500" });
    expect(rec2?.matched).toBe(false);
    expect(rec2?.diffIqd).toBe("50000.00"); // رصيدنا أعلى بـ50,000 (بند معلّق لديهم)
  });

  it("رصيد افتتاحي سالب (علينا للصيرفة): المحفظتان تُقبلان السالب ومعزولتان تماماً", async () => {
    const { id } = await createExchangeHouse(
      { name: "عبد القادر العبيدي", openingBalanceIqd: "-2500000", openingBalanceUsd: "-1000", openingUsdRate: "1550" },
      actor,
    );
    const h = await getExchangeHouse(id);
    expect(h?.balanceIqd).toBe("-2500000.00");
    expect(h?.balanceUsd).toBe("-1000.00");
    expect(h?.usdCostRate).toBe("1550.0000");
    // قيمة معادِلة: -2,500,000 + (-1000×1550) = -4,050,000.
    expect(await ledgerAmount("OPENING", id)).toBe("-4050000.00");

    const buy = await buyUsdAtExchange({ exchangeHouseId: id, branchId: 1, usdAmount: "100", exchangeRate: "1500" }, actor);
    await reverseExchangeTransaction(buy.txnId, actorB);
    const replayed = await getExchangeHouse(id);
    expect(replayed?.balanceUsd).toBe("-1000.00");
    expect(replayed?.usdCostRate).toBe("1550.0000");
  });

  it("إيداع دولار مباشر: يستهلك الحيازة الفعلية بـWAVG ولا يخلطها مع control الصيرفة", async () => {
    const { id } = await createExchangeHouse({ name: "صيرفة" }, actor);
    const treasuryBefore = await treasuryBalance(1);

    await buyUsdAtExchange({ exchangeHouseId: id, branchId: 1, usdAmount: "1000", exchangeRate: "1500", confirmNegative: true }, actor);
    await buyUsdAtExchange({ exchangeHouseId: id, branchId: 1, usdAmount: "500", exchangeRate: "1600" }, actor);
    const res = await depositUsdApproved({ exchangeHouseId: id, branchId: 1, amount: "1000", currency: "USD", exchangeRate: "9999" });
    let h = await getExchangeHouse(id);
    expect(h?.balanceUsd).toBe("-500.00");
    expect(h?.balanceIqd).toBe("0.00"); // معزول — لم يتأثّر
    expect(h?.usdCostRate).toBe("1533.3333");
    // بلا حركة نقد حقيقية ⇒ لا receipt جديد، الخزينة كما هي.
    expect(await treasuryBalance(1)).toBe(treasuryBefore);
    // السعر الحر في الطلب لا يُستعمل: القيمة من WAVG الحيازة = 2,300,000 / 1,500.
    expect(await ledgerAmount("EXCHANGE_DEPOSIT", id)).toBe("1533333.33");

    await depositUsdApproved({ exchangeHouseId: id, branchId: 1, amount: "500", currency: "USD", exchangeRate: "1" });
    h = await getExchangeHouse(id);
    expect(h?.balanceUsd).toBe("0.00");
    expect(h?.usdCostRate).toBe("0.0000");
    expect(res.txnNumber).toMatch(/^EX-1-\d{8}-\d{5}$/);
  });

  it("SOD (تدقيق ٢٥/٧): إيداع الدولار المباشر يُنشأ معلّقاً بلا أثر، ويُطبَّق فقط باعتماد مديرٍ ثانٍ", async () => {
    const { id } = await createExchangeHouse({ name: "صيرفة" }, actor);
    await buyUsdAtExchange({ exchangeHouseId: id, branchId: 1, usdAmount: "1000", exchangeRate: "1500", confirmNegative: true }, actor);
    const dep = await depositToExchange(
      { exchangeHouseId: id, branchId: 1, amount: "1000", currency: "USD", exchangeRate: "1500" },
      actor,
    );
    expect(dep.pendingApproval).toBe(true);

    // قبل الاعتماد: لا رفع رصيد ولا WAVG ولا قيد إعلاميّ — العملية معلّقة تُستثنى من الاشتقاق.
    let h = await getExchangeHouse(id);
    expect(h?.balanceUsd).toBe("-1000.00");
    // ledgerAmount يُرجع "0.00" لا "0" عند غياب القيود (نوع COALESCE(SUM(decimal),0) عشريّ بمنزلتين).
    expect(await ledgerAmount("EXCHANGE_DEPOSIT", id)).toBe("0.00");
    expect((await listPendingExchangeDeposits(id)).length).toBe(1);

    // فصل المهام: لا يجوز أن يعتمده مُنشئه.
    await expect(approveExchangeDeposit(dep.txnId, actor)).rejects.toMatchObject({ code: "FORBIDDEN" });

    // اعتماد مديرٍ ثانٍ ⇒ يُطبَّق كاملاً.
    await approveExchangeDeposit(dep.txnId, actorB);
    h = await getExchangeHouse(id);
    expect(h?.balanceUsd).toBe("0.00");
    expect(h?.usdCostRate).toBe("0.0000");
    expect(await ledgerAmount("EXCHANGE_DEPOSIT", id)).toBe("1500000.00");
    expect((await listPendingExchangeDeposits(id)).length).toBe(0);

    // إعادة الاعتماد مرفوضة (لم يعُد معلّقاً).
    await expect(approveExchangeDeposit(dep.txnId, actorB)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("المالك يعتمد إيداعه القديم المعلّق حتى إن لم تحمل حمولة الراوتر isOwner", async () => {
    const { id } = await createExchangeHouse({ name: "صيرفة طلب قديم" }, actor);
    await buyUsdAtExchange(
      { exchangeHouseId: id, branchId: 1, usdAmount: "100", exchangeRate: "1500", confirmNegative: true },
      actor,
    );
    const pending = await depositToExchange(
      { exchangeHouseId: id, branchId: 1, amount: "100", currency: "USD", exchangeRate: "1500" },
      actor,
    );
    // يحاكي طلبا تاريخيا أنشأه المالك قبل تفعيل الاعتماد التلقائي.
    await db().update(s.exchangeTransactions).set({ createdBy: actorB.userId }).where(eq(s.exchangeTransactions.id, pending.txnId));

    await expect(approveExchangeDeposit(pending.txnId, actorB)).resolves.toMatchObject({ status: "ACTIVE" });
  });

  it("اعتماد إيداع دولار بلا حيازة كافية يفشل قبل أي أثر ويبقي الطلب معلّقاً", async () => {
    const { id } = await createExchangeHouse({ name: "صيرفة بلا دولار فعلي" }, actor);
    const dep = await depositToExchange(
      { exchangeHouseId: id, branchId: 1, amount: "100", currency: "USD", exchangeRate: "1500" },
      actor,
    );
    await expect(approveExchangeDeposit(dep.txnId, actorB)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect((await getExchangeHouse(id))?.balanceUsd).toBe("0.00");
    expect(await ledgerAmount("EXCHANGE_DEPOSIT", id)).toBe("0.00");
    const [txn] = await db().select().from(s.exchangeTransactions).where(eq(s.exchangeTransactions.id, dep.txnId));
    expect(txn).toMatchObject({ status: "PENDING_APPROVAL", iqdAmount: "0.00" });
  });

  it("سحب دولار مباشر: يحوّل control موجباً إلى حيازة فعلية ويغلق عبور الصفر بلا سعر مصدر", async () => {
    const { id } = await createExchangeHouse({ name: "صيرفة", openingBalanceUsd: "1000", openingUsdRate: "1500" }, actor);
    const treasuryBefore = await treasuryBalance(1);

    await withdrawFromExchange({ exchangeHouseId: id, branchId: 1, amount: "300", currency: "USD" }, actor);
    let h = await getExchangeHouse(id);
    expect(h?.balanceUsd).toBe("700.00");
    expect(h?.usdCostRate).toBe("1500.0000"); // WAVG لا يتغيّر بالسحب
    expect(h?.balanceIqd).toBe("0.00");
    expect(await treasuryBalance(1)).toBe(treasuryBefore); // بلا receipt

    // لا يحمل المسار سعراً لالتزام جديد؛ confirmNegative لا يجيز اختلاق كلفته.
    await expect(
      withdrawFromExchange({ exchangeHouseId: id, branchId: 1, amount: "800", currency: "USD" }, actor),
    ).rejects.toThrow();
    h = await getExchangeHouse(id);
    expect(h?.balanceUsd).toBe("700.00"); // لم يتغيّر بعد الرفض

    await expect(
      withdrawFromExchange({ exchangeHouseId: id, branchId: 1, amount: "800", currency: "USD", confirmNegative: true }, actor),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    h = await getExchangeHouse(id);
    expect(h?.balanceUsd).toBe("700.00");

    await withdrawFromExchange({ exchangeHouseId: id, branchId: 1, amount: "700", currency: "USD" }, actor);
    h = await getExchangeHouse(id);
    expect(h?.balanceUsd).toBe("0.00");
    expect(h?.usdCostRate).toBe("0.0000");
  });

  it("كشف الحساب: إجمالي الإيداع/السحب الدولاري المباشر لا يُخلط مع الديناري", async () => {
    const { id } = await createExchangeHouse({ name: "صيرفة", openingBalanceUsd: "1000", openingUsdRate: "1500" }, actor);
    await depositToExchange({ exchangeHouseId: id, branchId: 1, amount: "500000" }, actor); // IQD
    await buyUsdAtExchange({ exchangeHouseId: id, branchId: 1, usdAmount: "1000", exchangeRate: "1500" }, actor);
    await depositUsdApproved({ exchangeHouseId: id, branchId: 1, amount: "1000", currency: "USD", exchangeRate: "1500" });
    await withdrawFromExchange({ exchangeHouseId: id, branchId: 1, amount: "200", currency: "USD" }, actor);

    const st = await getExchangeStatement({ exchangeHouseId: id });
    expect(st?.summary.totalDepositIqd).toBe("500000.00");
    expect(st?.summary.totalDepositUsd).toBe("1000.00");
    expect(st?.summary.totalWithdrawUsd).toBe("200.00");
    expect(st?.summary.totalWithdrawIqd).toBe("0.00");
    expect(st?.transactions.find((t) => t.type === "DEPOSIT" && t.currency === "USD")?.iqdAmount).toBe("1500000.00");
    expect(st?.transactions.find((t) => t.type === "WITHDRAW" && t.currency === "USD")?.iqdAmount).toBe("300000.00");
  });
});

describe("exchange-house — تكامل التقارير والمطابقة (إصلاحات مراجعة Codex)", () => {
  beforeEach(async () => {
    await reset();
    await seed();
  });

  it("الإيداع لا يُغيّر حقوق الملكية (نقل أصل: الخزينة↓ يقابله رصيد الصيرفة↑)", async () => {
    const before = await getFinancialPosition({ verify: false });
    const { id } = await createExchangeHouse({ name: "صيرفة" }, actor);
    await depositToExchange({ exchangeHouseId: id, branchId: 1, amount: "2000000" }, actor);
    const after = await getFinancialPosition({ verify: false });
    expect(after.equity).toBe(before.equity); // الإيداع لا يَخلق/يُفني قيمة
    expect(after.exchangeDebit).toBe("2000000.00"); // الأصل يَظهر في الميزانية
  });

  it("تسديد مورد عبر الصيرفة لا يُحدث انحراف AP في reconcileSupplierBalances", async () => {
    // أساس متّسق: قيد OPENING للمورد يطابق رصيده المبذور (2,000,000).
    await db().insert(s.accountingEntries).values({
      entryType: "OPENING", supplierId: 1, branchId: 1,
      amount: "2000000.00", entryDate: new Date("2026-01-01"),
      dedupeKey: "OPENING:SUPPLIER:1",
    });
    expect(await reconcileSupplierBalances()).toEqual([]); // الأساس نظيف

    const { id } = await createExchangeHouse({ name: "صيرفة" }, actor);
    await depositToExchange({ exchangeHouseId: id, branchId: 1, amount: "2000000" }, actor);
    await buyUsdAtExchange({ exchangeHouseId: id, branchId: 1, usdAmount: "1000", exchangeRate: "1400", confirmNegative: true }, actor);
    await settleSupplierViaExchange(
      { exchangeHouseId: id, branchId: 1, supplierId: 1, currency: "USD", walletAmount: "900", settledIqd: "1300000", commission: "10" },
      actor,
    );
    // EXCHANGE_SETTLE مُدرَج في صيغة المطابقة ⇒ لا انحراف رغم خفض رصيد المورد.
    expect(await reconcileSupplierBalances()).toEqual([]);
  });

  it("العمولة وفرق الصرف يظهران في قائمة الأرباح والخسائر", async () => {
    const { id } = await createExchangeHouse({ name: "صيرفة" }, actor);
    await depositToExchange({ exchangeHouseId: id, branchId: 1, amount: "2000000" }, actor);
    await buyUsdAtExchange({ exchangeHouseId: id, branchId: 1, usdAmount: "1000", exchangeRate: "1400", confirmNegative: true }, actor);
    await settleSupplierViaExchange(
      { exchangeHouseId: id, branchId: 1, supplierId: 1, currency: "USD", walletAmount: "900", settledIqd: "1300000", commission: "10" },
      actor,
    );
    const pl = await getProfitAndLoss({ from: "2020-01-01", to: "2099-12-31" });
    const keys = pl.current.expenseLines.map((l) => l.key);
    expect(keys).toContain("EXCHANGE_FEE"); // عمولة 14,000 (10$ × 1400)
    expect(keys).toContain("EXCHANGE_FX_DIFF"); // مكسب صرف 40,000 (سطر سالب يَخفض المصروف)
    const fee = pl.current.expenseLines.find((l) => l.key === "EXCHANGE_FEE");
    expect(fee?.amount).toBe("14000.00");
  });

  it("admin بلا فرع يُنشئ صيرفة برصيد افتتاحي (branchId=null لا 0)", async () => {
    const adminNoBranch = { userId: 1, branchId: 0, role: "admin" } as const;
    const { id } = await createExchangeHouse({ name: "صيرفة admin", openingBalanceIqd: "500000" }, adminNoBranch);
    const h = await getExchangeHouse(id);
    expect(h?.balanceIqd).toBe("500000.00"); // لم يَفشل بـFK على فرع 0 غير موجود
  });

  it("تسديد بالدينار: تباين المسحوب والمُسوّى مرفوض، والتساوي يُخزّن المُسوّى", async () => {
    const { id } = await createExchangeHouse({ name: "صيرفة" }, actor);
    await depositToExchange({ exchangeHouseId: id, branchId: 1, amount: "2000000" }, actor);
    await db().update(s.suppliers)
      .set({ currentBalanceUsd: "500.00" })
      .where(eq(s.suppliers.id, 1));
    await expect(
      settleSupplierViaExchange(
        { exchangeHouseId: id, branchId: 1, supplierId: 1, currency: "IQD", walletAmount: "1000000", settledIqd: "900000" },
        actor,
      ),
    ).rejects.toThrow();
    await settleSupplierViaExchange(
      { exchangeHouseId: id, branchId: 1, supplierId: 1, currency: "IQD", walletAmount: "1000000", settledIqd: "1000000" },
      actor,
    );
    const st = await getExchangeStatement({ exchangeHouseId: id });
    expect(st?.summary.totalSettledIqd).toBe("1000000.00"); // iqdAmount = المُسوّى لا المسحوب
    const [supplier, house, txn] = await Promise.all([
      db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)).then((r) => r[0]),
      getExchangeHouse(id),
      db().select().from(s.exchangeTransactions).where(eq(s.exchangeTransactions.exchangeHouseId, id)).then((r) => r.find((t) => t.type === "SETTLE")),
    ]);
    expect(supplier.currentBalance).toBe("1000000.00");
    expect(supplier.currentBalanceUsd).toBe("500.00"); // تسديد الدينار لا يلمس حساب الدولار
    expect(house?.balanceIqd).toBe("1000000.00");
    expect(house?.balanceUsd).toBe("0.00");
    expect(txn?.settledUsd).toBe("0.00");
  });
});

const reverser = { userId: 2, branchId: 1, role: "manager" } as const;

describe("reverseExchangeTransaction — عكس عملية صيرفة (تدقيق ١٧/٧)", () => {
  it("عكس إيصال الصيرفة لا يقفل receipt قبل branch مقابل OUT متزامن", async () => {
    const { id } = await createExchangeHouse({ name: "صيرفة ترتيب الأقفال" }, actor);
    const dep = await depositToExchange({
      exchangeHouseId: id, branchId: 1, amount: "100000", currency: "IQD",
      clientRequestId: "exchange-lock-order-deposit",
    }, actor);

    let sourceLocked!: () => void;
    let releaseSource!: () => void;
    const sourceIsLocked = new Promise<void>((resolve) => { sourceLocked = resolve; });
    const mayContinue = new Promise<void>((resolve) => { releaseSource = resolve; });
    const directOut = withTx(async (tx) => {
      await lockCashSourceForUpdate(tx, { branchId: 1, cashBucket: "TREASURY" });
      sourceLocked();
      await mayContinue;
      await assertCashOutAvailable(tx, {
        branchId: 1, cashBucket: "TREASURY", amount: "50000",
        operation: "صرف موازٍ لعكس الصيرفة",
      });
      await tx.insert(s.receipts).values({
        branchId: 1, cashBucket: "TREASURY", direction: "OUT", amount: "50000.00",
        paymentMethod: "CASH", status: "COMPLETED", approvalStatus: "APPROVED",
        referenceNumber: "EXCHANGE-LOCK-ORDER-OUT", createdBy: actor.userId,
      });
    });
    await sourceIsLocked;
    const reversal = reverseExchangeTransaction(dep.txnId, reverser);
    await new Promise((resolve) => setTimeout(resolve, 75));
    releaseSource();

    const results = await Promise.allSettled([directOut, reversal]);
    expect(results.flatMap((result) => result.status === "rejected"
      ? [String(result.reason?.message ?? result.reason)]
      : [])).toEqual([]);
    expect(await treasuryBalance(1)).toBe("9950000.00");
    expect((await getExchangeHouse(id))?.balanceIqd).toBe("0.00");
  });

  beforeEach(async () => {
    await reset();
    await seed();
  });

  it("عكس شراء دولار يُعيد اشتقاق WAVG من السجلّ النشط (نموذج الدَّين — الدينار لا يُمسّ إطلاقاً)", async () => {
    const { id } = await createExchangeHouse({ name: "صيرفة" }, actor);
    await depositToExchange({ exchangeHouseId: id, branchId: 1, amount: "1000000", currency: "IQD" }, actor);
    const b1 = await buyUsdAtExchange({ exchangeHouseId: id, branchId: 1, usdAmount: "100", exchangeRate: "1500", confirmNegative: true }, actor);
    const b2 = await buyUsdAtExchange({ exchangeHouseId: id, branchId: 1, usdAmount: "100", exchangeRate: "1600" }, actor); // سالبٌ أصلاً ⇒ بلا تأكيدٍ إضافي
    let house = await getExchangeHouse(id);
    expect(Number(house!.balanceUsd)).toBe(-200); // دَينٌ دولاريّ، لا أصل
    expect(Number(house!.usdCostRate)).toBe(1550); // (100×1500 + 100×1600)/200
    expect(Number(house!.balanceIqd)).toBe(1000000); // لا يُمسّ إطلاقاً بأيّ من الشراءَين

    // يمنع عكس شراء أقدم مع وجود أي FX_BUY لاحق؛ ثم ينجح LIFO الآمن.
    await expect(reverseExchangeTransaction(b1.txnId, reverser)).rejects.toThrow(/العملية اللاحقة/);
    await reverseExchangeTransaction(b2.txnId, reverser);
    const res = await reverseExchangeTransaction(b1.txnId, reverser);
    expect(res.status).toBe("REVERSED");
    house = await getExchangeHouse(id);
    expect(Number(house!.balanceUsd)).toBe(0);
    expect(Number(house!.balanceUsdCarryingIqd)).toBe(0);
    expect(Number(house!.usdCostRate)).toBe(0);
    expect(Number(house!.balanceIqd)).toBe(1000000); // ما زال بلا تغيير

    const [t] = await db().select().from(s.exchangeTransactions).where(eq(s.exchangeTransactions.id, b1.txnId));
    expect(t.status).toBe("REVERSED");
    const rev = await db().select().from(s.accountingEntries).where(sql`${s.accountingEntries.dedupeKey} LIKE 'EXREV:%'`);
    expect(rev).toHaveLength(2); // عكس قيدي الشراء؛ إعادة التصنيف لها مفاتيح EXCTRL مستقلة.
  });

  it("FX_BUY يعبر control من أصل إلى التزام بسعر مستقل ثم يعكس الحيازة والقيد بالكامل", async () => {
    const { id } = await createExchangeHouse(
      { name: "صيرفة عبور", openingBalanceUsd: "100", openingUsdRate: "1500" },
      actor,
    );
    const buy = await buyUsdAtExchange(
      { exchangeHouseId: id, branchId: 1, usdAmount: "150", exchangeRate: "1600", confirmNegative: true },
      actor,
    );
    let house = await getExchangeHouse(id);
    expect(house?.balanceUsd).toBe("-50.00");
    expect(house?.usdCostRate).toBe("1600.0000");
    expect(await ledgerAmount("EXCHANGE_FX_BUY", id)).toBe("240000.00");
    expect(await ledgerAmount("EXCHANGE_FX_DIFF", id)).toBe("10000.00");
    let custody = await withTx((tx) => deriveForeignCashUsdPosition(tx, id, 1));
    expect(custody.quantityUsd.toFixed(2)).toBe("150.00");
    expect(custody.carryingIqd.toFixed(2)).toBe("240000.00");

    await reverseExchangeTransaction(buy.txnId, reverser);
    house = await getExchangeHouse(id);
    expect(house?.balanceUsd).toBe("100.00");
    expect(house?.usdCostRate).toBe("1500.0000");
    expect(await ledgerAmount("EXCHANGE_FX_BUY", id)).toBe("0.00");
    expect(await ledgerAmount("EXCHANGE_FX_DIFF", id)).toBe("0.00");
    custody = await withTx((tx) => deriveForeignCashUsdPosition(tx, id, 1));
    expect(custody.quantityUsd.toFixed(2)).toBe("0.00");
    expect(custody.carryingIqd.toFixed(2)).toBe("0.00");
  });

  it("عكس تسديد مورد يعيد دين المورد ورصيد المحفظة، ويعكس قيود الكشف، وWAVG بلا تغيير", async () => {
    const { id } = await createExchangeHouse({ name: "صيرفة" }, actor);
    await depositToExchange({ exchangeHouseId: id, branchId: 1, amount: "2000000", currency: "IQD" }, actor);
    await buyUsdAtExchange({ exchangeHouseId: id, branchId: 1, usdAmount: "1000", exchangeRate: "1400", confirmNegative: true }, actor); // WAVG 1400، دَينٌ دولاريّ -1000
    const st = await settleSupplierViaExchange(
      { exchangeHouseId: id, branchId: 1, supplierId: 1, currency: "USD", walletAmount: "500", settledIqd: "750000", commission: "10", exchangeRate: "1400" },
      actor,
    );
    let sup = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0];
    expect(Number(sup.currentBalance)).toBe(1250000); // 2000000 − 750000
    const flowWhileSettled = (await getCashFlowSeries(
      { days: 1, branchId: 1 },
      { scopedBranchId: null, role: "admin" },
    )).at(-1)!;

    await reverseExchangeTransaction(st.txnId, reverser);
    sup = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0];
    expect(Number(sup.currentBalance)).toBe(2000000); // الدين استُعيد
    const house = await getExchangeHouse(id);
    expect(Number(house!.balanceUsd)).toBe(-1000); // يعود لحال ما بعد الشراء فقط (قبل التسديد)
    expect(Number(house!.usdCostRate)).toBe(1400); // الصرف لا يمسّ المعدّل
    expect(Number(house!.balanceIqd)).toBe(2000000); // لم يُمسّ طوال العملية (شراء ثم تسديد بالدولار)
    const stmt = await getExchangeStatement({ exchangeHouseId: id });
    expect(stmt?.summary.totalSettledIqd).toBe("0.00"); // المعكوسة مُستثناة من الإجماليات
    const [voucher] = await db().select().from(s.receipts).where(eq(s.receipts.id, Number(st.receiptId)));
    expect(voucher.status).toBe("REVERSED");
    const exchangeReceipts = await db().select().from(s.receipts).where(eq(s.receipts.paymentMethod, "EXCHANGE"));
    expect(exchangeReceipts).toHaveLength(2);
    expect(exchangeReceipts.map((receipt) => receipt.direction).sort()).toEqual(["IN", "OUT"]);
    expect(exchangeReceipts.every((receipt) => receipt.approvalStatus === "APPROVED")).toBe(true);
    const exchangeBreakdown = (await getPaymentMethodBreakdown(
      { period: "today", branchId: 1 },
      { scopedBranchId: null, role: "admin" },
    )).find((slice) => slice.key === "EXCHANGE")!;
    expect(exchangeBreakdown).toMatchObject({ inTotal: "750000.00", outTotal: "750000.00", count: 2 });
    const flowAfterReverse = (await getCashFlowSeries(
      { days: 1, branchId: 1 },
      { scopedBranchId: null, role: "admin" },
    )).at(-1)!;
    expect(Number(flowAfterReverse.net) - Number(flowWhileSettled.net)).toBe(750000);
  });

  it("عكس تسوية EXCHANGE في يوم لاحق يوازن التدفق عبر الفترتين ولا يمحو التاريخ", async () => {
    const { id } = await createExchangeHouse({ name: "صيرفة عبر الفترات" }, actor);
    await depositToExchange({ exchangeHouseId: id, branchId: 1, amount: "2000000", currency: "IQD" }, actor);
    const settled = await settleSupplierViaExchange(
      {
        exchangeHouseId: id,
        branchId: 1,
        supplierId: 1,
        currency: "IQD",
        walletAmount: "500000",
        settledIqd: "500000",
      },
      actor,
    );
    const yesterday = new Date(utcTodayStart().getTime() - 12 * 60 * 60 * 1000);
    // هذا الإيصال يُعتمَد ذاتياً لحظة إنشائه (approvedBy=createdBy وapprovedAt=createdAt معاً
    // في settleSupplier.ts) — فمحاكاةُ «حدث فعلاً بالأمس» تُبدّل الاثنين معاً، وإلا بقيت
    // approvedAt عند «اليوم» وcashEventAtSql (يعتمد على وقوع اعتمادٍ فعليّ لا هويّة المعتمِد
    // منذ قرار المالك ٣/٩/٢٦) يؤرّخ الحدث بها فيُخفي تدفّق الأمس زوراً.
    await db()
      .update(s.receipts)
      .set({ createdAt: yesterday, approvedAt: yesterday })
      .where(eq(s.receipts.id, Number(settled.receiptId)));

    await reverseExchangeTransaction(settled.txnId, reverser);

    const yesterdayExchange = (await getPaymentMethodBreakdown(
      { period: "yesterday", branchId: 1 },
      { scopedBranchId: null, role: "admin" },
    )).find((slice) => slice.key === "EXCHANGE")!;
    const todayExchange = (await getPaymentMethodBreakdown(
      { period: "today", branchId: 1 },
      { scopedBranchId: null, role: "admin" },
    )).find((slice) => slice.key === "EXCHANGE")!;
    expect(yesterdayExchange).toMatchObject({ inTotal: "0.00", outTotal: "500000.00", count: 1 });
    expect(todayExchange).toMatchObject({ inTotal: "500000.00", outTotal: "0.00", count: 1 });

    const flow = await getCashFlowSeries(
      { days: 2, branchId: 1 },
      { scopedBranchId: null, role: "admin" },
    );
    expect(flow.at(-2)).toMatchObject({ inflow: "0.00", outflow: "500000.00", net: "-500000.00" });
    expect(flow.at(-1)).toMatchObject({ inflow: "10500000.00", outflow: "2000000.00", net: "8500000.00" });
    expect(flow.reduce((sum, point) => sum + Number(point.net), 0)).toBe(8000000);
    expect((await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0].currentBalance).toBe("2000000.00");
    expect((await getExchangeHouse(id))?.balanceIqd).toBe("2000000.00");
  });

  it("تسوية جديدة وعكس تسوية سابقة لنفس المورد والمحفظة لا يتعاكسان في الأقفال", async () => {
    const { id } = await createExchangeHouse({ name: "صيرفة سباق التسوية" }, actor);
    await depositToExchange({ exchangeHouseId: id, branchId: 1, amount: "2000000", currency: "IQD" }, actor);
    const prior = await settleSupplierViaExchange(
      { exchangeHouseId: id, branchId: 1, supplierId: 1, currency: "IQD", walletAmount: "500000", settledIqd: "500000" },
      actor,
    );

    const results = await Promise.allSettled([
      settleSupplierViaExchange(
        {
          exchangeHouseId: id,
          branchId: 1,
          supplierId: 1,
          currency: "IQD",
          walletAmount: "100000",
          settledIqd: "100000",
          clientRequestId: "settle-while-reversing",
        },
        actor,
      ),
      reverseExchangeTransaction(prior.txnId, reverser),
    ]);

    expect(results.flatMap((result) => result.status === "rejected"
      ? [String(result.reason?.message ?? result.reason)]
      : [])).toEqual([]);
    expect((await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0].currentBalance).toBe("1900000.00");
    expect((await getExchangeHouse(id))?.balanceIqd).toBe("1900000.00");
  });

  it("تسوية EXCHANGE واعتماد سند نقدي للمورد نفسه يتسلسلان branch→supplier بلا deadlock", async () => {
    const { id } = await createExchangeHouse({ name: "صيرفة سباق السند" }, actor);
    await depositToExchange({ exchangeHouseId: id, branchId: 1, amount: "1000000", currency: "IQD" }, actor);
    const voucher = await createVoucher({
      voucherType: "PAYMENT",
      branchId: 1,
      amount: "100000",
      paymentMethod: "CASH",
      partyType: "SUPPLIER",
      partyId: 1,
      description: "سند متزامن مع تسوية صيرفة",
      clientRequestId: "exchange-voucher-lock-order",
    }, actor);

    const results = await Promise.allSettled([
      settleSupplierViaExchange({
        exchangeHouseId: id,
        branchId: 1,
        supplierId: 1,
        currency: "IQD",
        walletAmount: "100000",
        settledIqd: "100000",
        clientRequestId: "exchange-settle-vs-voucher",
      }, actor),
      approveVoucher(voucher.receiptId, actorB),
    ]);

    expect(results.filter((result) => result.status === "rejected")).toEqual([]);
    expect((await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0].currentBalance).toBe("1800000.00");
  }, 15_000);

  it("عكس إيداع دينار يعيد النقد للخزينة بإيصال تعويضيّ", async () => {
    const { id } = await createExchangeHouse({ name: "صيرفة" }, actor);
    const dep = await depositToExchange({ exchangeHouseId: id, branchId: 1, amount: "500000", currency: "IQD" }, actor);
    expect(Number(await treasuryBalance(1))).toBe(9500000);

    await reverseExchangeTransaction(dep.txnId, reverser);
    expect(Number(await treasuryBalance(1))).toBe(10000000); // عاد النقد للخزينة
    const house = await getExchangeHouse(id);
    expect(Number(house!.balanceIqd)).toBe(0); // محفظة الدينار استُعيدت
  });

  it("عكس سحب IQD وسحب جديد يقفلان branch→house بلا deadlock", async () => {
    const { id } = await createExchangeHouse({ name: "صيرفة سباق السحب" }, actor);
    await depositToExchange({ exchangeHouseId: id, branchId: 1, amount: "2000000", currency: "IQD" }, actor);
    const prior = await withdrawFromExchange(
      { exchangeHouseId: id, branchId: 1, amount: "500000", currency: "IQD" },
      actor,
    );

    const results = await Promise.allSettled([
      reverseExchangeTransaction(prior.txnId, reverser),
      withdrawFromExchange(
        {
          exchangeHouseId: id,
          branchId: 1,
          amount: "100000",
          currency: "IQD",
          clientRequestId: "withdraw-while-reversing",
        },
        actor,
      ),
    ]);

    expect(results.flatMap((result) => result.status === "rejected"
      ? [String(result.reason?.message ?? result.reason)]
      : [])).toEqual([]);
    expect((await getExchangeHouse(id))?.balanceIqd).toBe("1900000.00");
    expect(await treasuryBalance(1)).toBe("8100000.00");
  });

  it("فصل المهام: المُنشئ لا يعكس عمليته بنفسه؛ ومنفِّذٌ آخر يمرّ؛ والعكس المزدوج مرفوض", async () => {
    const { id } = await createExchangeHouse({ name: "صيرفة" }, actor);
    await depositToExchange({ exchangeHouseId: id, branchId: 1, amount: "1000000", currency: "IQD" }, actor);
    const b = await buyUsdAtExchange({ exchangeHouseId: id, branchId: 1, usdAmount: "100", exchangeRate: "1500", confirmNegative: true }, actor);
    await expect(reverseExchangeTransaction(b.txnId, actor)).rejects.toThrow(/فصل المهام/); // actor = المُنشئ
    await reverseExchangeTransaction(b.txnId, reverser); // منفِّذٌ آخر ⇒ يمرّ
    await expect(reverseExchangeTransaction(b.txnId, reverser)).rejects.toThrow(/معكوسة سابقاً/);
  });
});

describe("FOREIGN_CASH_USD — الحيازة الدقيقة والتصنيف الإجمالي", () => {
  beforeEach(async () => {
    await reset();
    await seed();
  });

  it("يعزل الحيازة حسب (الصيرفة، الفرع) ولا يسمح لفرع بإيداع دولار حازه فرع آخر", async () => {
    const { id } = await createExchangeHouse({ name: "صيرفة متعددة الفروع" }, actor);
    await buyUsdAtExchange({
      exchangeHouseId: id,
      branchId: 1,
      usdAmount: "10",
      exchangeRate: "1450.1234",
      confirmNegative: true,
    }, actor);

    const pending = await createExchangeDepositRequest({
      exchangeHouseId: id,
      branchId: 2,
      amount: "5",
      currency: "USD",
      exchangeRate: "1450.1234",
      clientRequestId: "cross-branch-usd-deposit",
    }, actorBranch2);
    await expect(approveExchangeDeposit(pending.txnId, actorBranch2B)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });

    const [branch1, branch2] = await Promise.all([
      withTx((tx) => deriveForeignCashUsdPosition(tx, id, 1)),
      withTx((tx) => deriveForeignCashUsdPosition(tx, id, 2)),
    ]);
    expect(branch1.quantityUsd.toFixed(2)).toBe("10.00");
    expect(branch1.carryingIqd.toFixed(2)).toBe("14501.23");
    expect(branch2.quantityUsd.toFixed(2)).toBe("0.00");
    expect((await getExchangeHouse(id))?.balanceUsd).toBe("-10.00");
    expect((await db().select().from(s.exchangeTransactions).where(eq(s.exchangeTransactions.id, pending.txnId)))[0].status)
      .toBe("PENDING_APPROVAL");

    const statement = await getExchangeStatement({ exchangeHouseId: id });
    expect(statement?.physicalUsdByBranch).toEqual([
      expect.objectContaining({ branchId: 1, quantityUsd: "10.00", carryingIqd: "14501.23" }),
    ]);
  });

  it("يحفظ سنت carrying authoritative عبر WAVG رباعي المنازل ويصفّر الكمية والقيمة معاً", async () => {
    const { id } = await createExchangeHouse({
      name: "صيرفة دقة السنت",
      openingBalanceUsd: "3",
      openingUsdRate: "0.3333",
    }, actor);
    expect((await getExchangeHouse(id))?.balanceUsdCarryingIqd).toBe("1.00");

    await withdrawFromExchange({ exchangeHouseId: id, branchId: 1, amount: "1", currency: "USD" }, actor);
    let house = await getExchangeHouse(id);
    expect(house?.balanceUsdCarryingIqd).toBe("0.67");
    expect(house?.usdCostRate).toBe("0.3350");
    await withdrawFromExchange({ exchangeHouseId: id, branchId: 1, amount: "1", currency: "USD" }, actor);
    house = await getExchangeHouse(id);
    expect(house?.balanceUsdCarryingIqd).toBe("0.33");
    await withdrawFromExchange({ exchangeHouseId: id, branchId: 1, amount: "1", currency: "USD" }, actor);
    house = await getExchangeHouse(id);
    expect(house).toMatchObject({ balanceUsd: "0.00", balanceUsdCarryingIqd: "0.00", usdCostRate: "0.0000" });

    const withdrawals = (await db().select().from(s.exchangeTransactions))
      .filter((row) => row.type === "WITHDRAW" && row.currency === "USD");
    expect(withdrawals.map((row) => row.iqdAmount)).toEqual(["0.33", "0.34", "0.33"]);
    const custody = await withTx((tx) => deriveForeignCashUsdPosition(tx, id, 1));
    expect(custody.quantityUsd.toFixed(2)).toBe("3.00");
    expect(custody.carryingIqd.toFixed(2)).toBe("1.00");
  });

  it("يرفض صفراً كمياً مع carrying متبقٍ ولا يبتلع السنت", async () => {
    const { id } = await createExchangeHouse({ name: "صيرفة حارس الصفر" }, actor);
    await db().insert(s.exchangeTransactions).values([
      {
        txnNumber: "USD-ZERO-IN",
        exchangeHouseId: id,
        branchId: 1,
        type: "FX_BUY",
        currency: "USD",
        usdAmount: "1.00",
        iqdAmount: "1.00",
        exchangeRate: "1.0000",
        status: "ACTIVE",
      },
      {
        txnNumber: "USD-ZERO-OUT",
        exchangeHouseId: id,
        branchId: 1,
        type: "DEPOSIT",
        currency: "USD",
        usdAmount: "1.00",
        iqdAmount: "0.99",
        exchangeRate: "0.9900",
        status: "ACTIVE",
      },
    ]);
    await expect(withTx((tx) => deriveForeignCashUsdPosition(tx, id, 1))).rejects.toThrow(/صفر/);
  });

  it("يطبّق حدود تاريخ بغداد بنهاية حصرية", async () => {
    const { id } = await createExchangeHouse({ name: "صيرفة حدود بغداد" }, actor);
    const points = [
      "2026-08-14T20:59:59.000Z",
      "2026-08-14T21:00:00.000Z",
      "2026-08-15T20:59:59.000Z",
      "2026-08-15T21:00:00.000Z",
    ];
    await db().insert(s.exchangeTransactions).values(points.map((createdAt, index) => ({
      txnNumber: `BAGHDAD-${index}`,
      exchangeHouseId: id,
      branchId: 1,
      type: "OPENING" as const,
      currency: "IQD" as const,
      status: "REVERSED" as const,
      createdAt: new Date(createdAt),
    })));
    const statement = await getExchangeStatement({ exchangeHouseId: id, from: "2026-08-15", to: "2026-08-15" });
    expect(statement?.transactions.map((row) => row.txnNumber)).toEqual(["BAGHDAD-1", "BAGHDAD-2"]);
  });

  it.each(["SHADOW", "ACTIVE"] as const)("يرحّل reclass إجمالياً في وضع %s بلا نسبة control إلى فرع", async (mode) => {
    await db().insert(s.doubleEntrySettings).values({
      id: 1,
      mode,
      shadowCycleId: `exchange-${mode.toLowerCase()}`,
      ...(mode === "ACTIVE" ? {
        shadowOpeningHash: "a".repeat(64),
        policyApprovalReference: "EXCHANGE-TEST",
        policyApprovalPolicyHash: POSTING_POLICY_HASH,
        policyApprovalCycleId: `exchange-${mode.toLowerCase()}`,
        policyApprovalOpeningHash: "a".repeat(64),
        policyAccountantName: "محاسب الاختبار",
        policyApprovedAt: new Date("2026-08-01T00:00:00.000Z"),
        policyApprovedBy: 2,
      } : {}),
    });
    const { id } = await createExchangeHouse({ name: `صيرفة ${mode}` }, actor);
    await buyUsdAtExchange({
      exchangeHouseId: id,
      branchId: 1,
      usdAmount: "10",
      exchangeRate: "1450.1234",
      confirmNegative: true,
    }, actor);

    const [head] = await db().select().from(s.journalEntries)
      .where(eq(s.journalEntries.postingProfile, "ADJUST_EXCHANGE_CONTROL_RECLASS"));
    expect(head).toMatchObject({ status: "POSTED", branchId: null });
    const lines = await db().select().from(s.journalLines).where(eq(s.journalLines.journalId, Number(head.id)));
    expect(lines.map((line) => ({ role: line.role, debit: line.debit, credit: line.credit }))).toEqual([
      { role: "EXCHANGE_WALLET_USD", debit: "14501.23", credit: "0.00" },
      { role: "EXCHANGE_PAYABLE_USD", debit: "0.00", credit: "14501.23" },
    ]);
  });
});
