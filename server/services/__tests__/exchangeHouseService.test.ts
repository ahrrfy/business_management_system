/**
 * اختبارات وحدة «الصيرفة» (exchange-house) — السلامة المالية ثنائية العملة:
 *  1) CRUD + رصيد افتتاحي + حماية تعطيل صيرفة برصيد.
 *  2) إيداع (الخزينة ↓ عبر receipt OUT، محفظة الدينار ↑) — نقل أصل.
 *  3) شراء دولار (WAVG: متوسط كلفة مرجّح صحيح، دينار↓ دولار↑).
 *  4) تسديد مورد بالدولار: محفظة الدولار ↓ + دين المورد ↓ + فرق صرف محقَّق + عمولة مصروف،
 *     **والخزينة لا تتأثّر** (لا receipt جديد) — أهمّ ثابت محاسبي.
 *  5) منع المكشوف بتحذير قابل للتجاوز (confirmNegative).
 *  6) كشف الحساب + المطابقة.
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  buyUsdAtExchange,
  createExchangeHouse,
  depositToExchange,
  getExchangeHouse,
  getExchangeStatement,
  reconcileExchange,
  setExchangeActive,
  settleSupplierViaExchange,
  withdrawFromExchange,
} from "../exchangeHouseService";

const TABLES = [
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
  await d.insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([
    { id: 1, openId: "local_mgr", name: "مدير", email: "m@t.test", role: "manager", loginMethod: "local", branchId: 1 },
  ]);
  // مورد نَدين له ٢٬٠٠٠٬٠٠٠ د.ع (AP موجب = علينا).
  await d.insert(s.suppliers).values([{ id: 1, name: "مورد الورق", currentBalance: "2000000.00" }]);
}

/** رصيد خزينة الفرع (نقد فعلي) = Σ(IN − OUT) على receipts TREASURY المكتملة. */
async function treasuryBalance(branchId: number): Promise<string> {
  const rows: any = await db().execute(sql`
    SELECT CAST(COALESCE(SUM(CASE WHEN direction='IN' THEN amount ELSE -amount END),0) AS CHAR) AS bal
    FROM receipts WHERE branchId=${branchId} AND cashBucket='TREASURY' AND receiptStatus='COMPLETED'`);
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

describe("exchange-house — وحدة الصيرفة ثنائية العملة", () => {
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
    await depositToExchange({ exchangeHouseId: id, branchId: 1, amount: "2000000" }, actor);

    const h = await getExchangeHouse(id);
    expect(h?.balanceIqd).toBe("2000000.00");
    // نقد فعلي غادر الخزينة (receipt OUT).
    expect(await treasuryBalance(1)).toBe("-2000000.00");
    expect(await ledgerAmount("EXCHANGE_DEPOSIT", id)).toBe("2000000.00");
  });

  it("شراء دولار: WAVG صحيح + دينار↓ دولار↑", async () => {
    const { id } = await createExchangeHouse({ name: "صيرفة" }, actor);
    await depositToExchange({ exchangeHouseId: id, branchId: 1, amount: "2000000" }, actor);
    // شراء ١٠٠٠$ بسعر ١٤٠٠ ⇒ يُنفَق ١٬٤٠٠٬٠٠٠ د.ع.
    const r1 = await buyUsdAtExchange({ exchangeHouseId: id, branchId: 1, usdAmount: "1000", exchangeRate: "1400" }, actor);
    expect(r1.newRate).toBe("1400.0000");
    let h = await getExchangeHouse(id);
    expect(h?.balanceIqd).toBe("600000.00");
    expect(h?.balanceUsd).toBe("1000.00");

    // شراء ٥٠٠$ إضافية بسعر ١٤٦٠ ⇒ WAVG = (1000×1400 + 500×1460)/1500 = 2,130,000/1500 = 1420.
    await depositToExchange({ exchangeHouseId: id, branchId: 1, amount: "730000" }, actor);
    const r2 = await buyUsdAtExchange({ exchangeHouseId: id, branchId: 1, usdAmount: "500", exchangeRate: "1460" }, actor);
    expect(r2.newRate).toBe("1420.0000");
    h = await getExchangeHouse(id);
    expect(h?.balanceUsd).toBe("1500.00");
  });

  it("تسديد مورد بالدولار: المحفظة ودين المورد ينخفضان + فرق صرف + عمولة، والخزينة لا تتأثّر", async () => {
    const { id } = await createExchangeHouse({ name: "صيرفة" }, actor);
    await depositToExchange({ exchangeHouseId: id, branchId: 1, amount: "2000000" }, actor);
    await buyUsdAtExchange({ exchangeHouseId: id, branchId: 1, usdAmount: "1000", exchangeRate: "1400" }, actor);

    const treasuryBefore = await treasuryBalance(1); // = -2,000,000 (الإيداع فقط)

    // تسديد: ٩٠٠$ من المحفظة لإطفاء دين ١٬٣٠٠٬٠٠٠ د.ع + عمولة ١٠$.
    const res = await settleSupplierViaExchange(
      { exchangeHouseId: id, branchId: 1, supplierId: 1, currency: "USD", walletAmount: "900", settledIqd: "1300000", commission: "10" },
      actor,
    );
    // فرق الصرف = 1,300,000 − (900×1400=1,260,000) = +40,000 (مكسب).
    expect(res.fxDiff).toBe("40000.00");

    const h = await getExchangeHouse(id);
    expect(h?.balanceUsd).toBe("90.00"); // 1000 − (900 + 10)
    expect(h?.balanceIqd).toBe("600000.00"); // لم يتأثّر (التسديد بالدولار)

    // دين المورد انخفض بمقدار المُسوّى فقط (1,300,000): 2,000,000 → 700,000.
    const sup = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)).limit(1))[0];
    expect(sup?.currentBalance).toBe("700000.00");

    // ⭐ الخزينة لم تتغيّر بالتسديد (النقد غادر عند الإيداع) — لا ازدواج خصم نقد.
    expect(await treasuryBalance(1)).toBe(treasuryBefore);

    // القيود: تسديد + فرق صرف + عمولة (10×1400=14,000).
    expect(await ledgerAmount("EXCHANGE_SETTLE", id)).toBe("1300000.00");
    expect(await ledgerAmount("EXCHANGE_FX_DIFF", id)).toBe("40000.00");
    expect(await ledgerAmount("EXCHANGE_FEE", id)).toBe("14000.00");
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

  it("منع المكشوف: سحب يتجاوز الرصيد يُرفض، ويُقبل مع confirmNegative", async () => {
    const { id } = await createExchangeHouse({ name: "صيرفة" }, actor);
    await depositToExchange({ exchangeHouseId: id, branchId: 1, amount: "100000" }, actor);

    await expect(
      withdrawFromExchange({ exchangeHouseId: id, branchId: 1, amount: "150000" }, actor),
    ).rejects.toThrow();

    await withdrawFromExchange({ exchangeHouseId: id, branchId: 1, amount: "150000", confirmNegative: true }, actor);
    const h = await getExchangeHouse(id);
    expect(h?.balanceIqd).toBe("-50000.00"); // علينا للصيرفة
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
    await buyUsdAtExchange({ exchangeHouseId: id, branchId: 1, usdAmount: "500", exchangeRate: "1400" }, actor);

    const st = await getExchangeStatement({ exchangeHouseId: id });
    expect(st?.transactions.length).toBe(2);
    expect(st?.summary.currentBalanceIqd).toBe("300000.00"); // 1,000,000 − 700,000
    expect(st?.summary.currentBalanceUsd).toBe("500.00");

    // مطابقة: رصيدنا 300,000 د.ع / 500$ مقابل ما يقوله الصرّاف.
    const rec = await reconcileExchange({ exchangeHouseId: id, statedBalanceIqd: "300000", statedBalanceUsd: "500" });
    expect(rec?.matched).toBe(true);
    expect(rec?.diffIqd).toBe("0.00");

    const rec2 = await reconcileExchange({ exchangeHouseId: id, statedBalanceIqd: "250000", statedBalanceUsd: "500" });
    expect(rec2?.matched).toBe(false);
    expect(rec2?.diffIqd).toBe("50000.00"); // رصيدنا أعلى بـ50,000 (بند معلّق لديهم)
  });
});
