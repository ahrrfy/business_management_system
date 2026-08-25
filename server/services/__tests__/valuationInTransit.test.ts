/**
 * قيمةُ المخزون بالطريق (P1-#1، تقرير المراجعة ٢٥/٨).
 *
 * قبل الإصلاح: `readInventoryValuation` يقرأ `branchStock` وحده ⇒ التحويلُ الذي خصم المصدر ولم
 * يصل الوجهة بعد يختفي من الأصل طوال فترة الطريق (يعود عند الاستلام). الإصلاح: نجمع المتبقّي
 * من `stockTransferLines` للسندات IN_TRANSIT بتكلفة WAVG الحاليّة، وننسبه إلى الفرع المصدر.
 */
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { readInventoryValuation } from "../inventory/valuation";
import { withTx } from "../tx";

const TABLES = [
  "stockTransferLines",
  "stockTransfers",
  "branchStock",
  "productVariants",
  "products",
  "branches",
  "users",
];

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
  await d.insert(s.users).values({
    id: 1,
    openId: "u-admin",
    name: "أدمن",
    role: "admin",
    loginMethod: "local",
    branchId: 1,
  });
  await d.insert(s.products).values([
    { id: 1, name: "قلم" },
    { id: 2, name: "بضاعة أمانة", isConsignment: true },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "PEN-1", costPrice: "100.00" },
    { id: 2, productId: 2, sku: "CONS-1", costPrice: "500.00" },
  ]);
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 10 },
    { variantId: 1, branchId: 2, quantity: 4 },
    { variantId: 2, branchId: 1, quantity: 3 },
  ]);
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe("قيمة المخزون — بلا سند بالطريق (السلوك الأصلي)", () => {
  it("total = مجموع المستقرّ فقط، inTransitTotal = 0.00", async () => {
    const v = await withTx((tx) => readInventoryValuation(tx));
    // 10 × 100 + 4 × 100 = 1400 (الأمانة مستبعَدة).
    expect(v.total).toBe("1400.00");
    expect(v.inTransitTotal).toBe("0.00");
    expect(v.branches).toEqual([
      { branchId: 1, value: "1000.00" },
      { branchId: 2, value: "400.00" },
    ]);
  });
});

describe("قيمة المخزون بالطريق تدخل في الأصل (P1-#1)", () => {
  async function createTransferInTransit(opts: {
    id: number;
    fromBranchId: number;
    toBranchId: number;
    variantId: number;
    quantitySent: number;
    quantityReceived?: number | null;
    baseFromStock: boolean;
  }) {
    const d = db();
    // ملاحظة: نُنشئ سند IN_TRANSIT مباشرةً ونخصم من المصدر يدوياً (تسريعُ الاختبار — نتحقّق من الاستعلام
    // لا من مسار الإرسال). المسار الحقيقيّ يفعل الأمرَين ذرّياً في transferService.
    await d.insert(s.stockTransfers).values({
      id: opts.id,
      transferNumber: `T-${opts.id}`,
      fromBranchId: opts.fromBranchId,
      toBranchId: opts.toBranchId,
      status: "IN_TRANSIT",
      totalSentBase: opts.quantitySent,
      createdBy: 1,
    });
    await d.insert(s.stockTransferLines).values({
      transferId: opts.id,
      variantId: opts.variantId,
      quantitySent: opts.quantitySent,
      quantityReceived: opts.quantityReceived ?? null,
    });
    if (opts.baseFromStock) {
      await d.execute(sql`
        UPDATE branchStock SET quantity = quantity - ${opts.quantitySent}
        WHERE variantId = ${opts.variantId} AND branchId = ${opts.fromBranchId}
      `);
    }
  }

  it("سندٌ IN_TRANSIT من فرع ١ ⇒ الأصلُ الإجماليّ يبقى ثابتاً (مستقرّ ٦٠٠ + بالطريق ٤٠٠ = ١٤٠٠)", async () => {
    // خصمنا ٤ من فرع ١ فأصبح ٦ ⇒ مستقرّ ف١ = 600، مستقرّ ف٢ = 400، بالطريق = 400.
    await createTransferInTransit({
      id: 1,
      fromBranchId: 1,
      toBranchId: 2,
      variantId: 1,
      quantitySent: 4,
      baseFromStock: true,
    });
    const v = await withTx((tx) => readInventoryValuation(tx));
    expect(v.total).toBe("1400.00"); // كما كان قبل الإرسال — لا اختفاءَ في الأصل.
    expect(v.inTransitTotal).toBe("400.00");
    // فرع ١ (المصدر) يحمل قيمةَ الطريق في `inTransitValue`.
    expect(v.branches).toEqual([
      { branchId: 1, value: "600.00", inTransitValue: "400.00" },
      { branchId: 2, value: "400.00" },
    ]);
  });

  it("استلام جزئيّ — الباقي بالطريق فقط (ما وصل يدخل المستقرّ الأول أوّلاً)", async () => {
    // سندٌ من ف١ إلى ف٢ بـ٤، استُلم ١ ⇒ الباقي بالطريق ٣ = 300. المصدر خُصم كلّه (٤).
    await createTransferInTransit({
      id: 2,
      fromBranchId: 1,
      toBranchId: 2,
      variantId: 1,
      quantitySent: 4,
      quantityReceived: 1,
      baseFromStock: true,
    });
    const v = await withTx((tx) => readInventoryValuation(tx));
    // مستقرّ: ف١ = ٦ × ١٠٠ = ٦٠٠، ف٢ = ٤ × ١٠٠ = ٤٠٠ (لم نضف المستلَم يدوياً هنا — نختبر الاستعلام فقط).
    // بالطريق: (٤ − ١) × ١٠٠ = ٣٠٠. الإجمالي = ١٣٠٠ (لا ١٤٠٠ لأنّ الاستلام لم يُضَف بعدُ إلى ف٢).
    expect(v.inTransitTotal).toBe("300.00");
    expect(v.total).toBe("1300.00");
    expect(v.branches.find((b) => b.branchId === 1)?.inTransitValue).toBe("300.00");
  });

  it("بضاعةُ الأمانة بالطريق مستبعَدةٌ (نفسُ شرطِ الميزانية)", async () => {
    await createTransferInTransit({
      id: 3,
      fromBranchId: 1,
      toBranchId: 2,
      variantId: 2, // الأمانة (isConsignment=true).
      quantitySent: 3,
      baseFromStock: true,
    });
    const v = await withTx((tx) => readInventoryValuation(tx));
    // لا يُضاف شيء (الأمانة مستبعَدة كأصل)؛ الأصل يبقى ١٤٠٠ من صفوف الأصل غير الأمانة.
    expect(v.inTransitTotal).toBe("0.00");
    expect(v.total).toBe("1400.00");
  });

  it("سندٌ RECEIVED لا يُحتسَب بالطريق (مقفولٌ، وصل الوجهة)", async () => {
    const d = db();
    await d.insert(s.stockTransfers).values({
      id: 4,
      transferNumber: "T-4",
      fromBranchId: 1,
      toBranchId: 2,
      status: "RECEIVED",
      totalSentBase: 4,
      totalReceivedBase: 4,
      createdBy: 1,
    });
    await d.insert(s.stockTransferLines).values({
      transferId: 4,
      variantId: 1,
      quantitySent: 4,
      quantityReceived: 4,
    });
    const v = await withTx((tx) => readInventoryValuation(tx));
    expect(v.inTransitTotal).toBe("0.00");
  });

  it("سندٌ CANCELLED لا يُحتسَب بالطريق", async () => {
    const d = db();
    await d.insert(s.stockTransfers).values({
      id: 5,
      transferNumber: "T-5",
      fromBranchId: 1,
      toBranchId: 2,
      status: "CANCELLED",
      totalSentBase: 4,
      createdBy: 1,
    });
    await d.insert(s.stockTransferLines).values({
      transferId: 5,
      variantId: 1,
      quantitySent: 4,
    });
    const v = await withTx((tx) => readInventoryValuation(tx));
    expect(v.inTransitTotal).toBe("0.00");
  });
});
