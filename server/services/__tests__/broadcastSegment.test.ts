// باني شرائح البث التسويقي (S5، T5.1) — segmentService.resolveSegmentCount/resolveSegmentList:
//  1) فلترة customerType/priceTier.
//  2) فلترة الرصيد (balanceMin/balanceMax).
//  3) RFM: VIP (بالتكرار أو الإنفاق)، AT_RISK، DORMANT، NEW.
//  4) استبعاد OPTED_OUT حتماً — عميل مطابق تماماً لمعايير VIP لكن OPTED_OUT لا يظهر أبداً.
//  5) استبعاد عميل بلا هاتف صالح (فارغ/قصير جداً) وعميل غير نشط (isActive=false).
//  6) requireOptIn: افتراضياً يشمل UNKNOWN؛ true يستبعده (يبقى OPTED_IN فقط).
//  7) عزل الفرع: RFM يُحتسَب من فواتير الفرع المطلوب فقط.
//  8) count يطابق list.length في كل الحالات أعلاه.
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { resolveSegmentCount, resolveSegmentList, type SegmentCriteria } from "../whatsapp/segmentService";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

const TABLES = ["invoices", "customers", "branches"];

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

/** ظهر اليوم بتوقيت UTC مطروحاً منه daysAgo — يتجنّب فخّ حدّ اليوم (نفس نمط dashboardMetrics.test.ts). */
function dayNoonUTC(daysAgo: number): Date {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12, 0, 0));
}

async function seedBranches() {
  await db().insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
  ]);
}

let invNo = 1;
async function addInvoice(opts: {
  customerId: number;
  branchId?: number;
  total: string;
  daysAgo: number;
  status?: string;
}) {
  await db().insert(s.invoices).values({
    invoiceNumber: `INV-SEG-${invNo++}`,
    sourceType: "POS",
    branchId: opts.branchId ?? 1,
    customerId: opts.customerId,
    subtotal: opts.total,
    total: opts.total,
    status: (opts.status ?? "PAID") as any,
    invoiceDate: dayNoonUTC(opts.daysAgo),
  });
}

beforeEach(async () => {
  await reset();
  await seedBranches();
});

describe("segmentService.resolveSegment — فلترة ديموغرافية", () => {
  it("customerType/priceTier: يفلتر بدقّة، count يطابق list", async () => {
    await db().insert(s.customers).values([
      { id: 1, name: "تاجر جملة", phone: "07701234567", customerType: "تاجر", defaultPriceTier: "WHOLESALE" },
      { id: 2, name: "فرد مفرّق", phone: "07701234568", customerType: "فرد", defaultPriceTier: "RETAIL" },
      { id: 3, name: "شركة حكومية", phone: "07701234569", customerType: "حكومي", defaultPriceTier: "GOVERNMENT" },
    ]);
    const criteria: SegmentCriteria = { customerTypes: ["تاجر"] };
    const count = await resolveSegmentCount(criteria);
    const list = await resolveSegmentList(criteria);
    expect(count).toBe(1);
    expect(list).toHaveLength(1);
    expect(list[0].customerId).toBe(1);
    expect(list[0].name).toBe("تاجر جملة");

    const criteria2: SegmentCriteria = { priceTiers: ["WHOLESALE", "GOVERNMENT"] };
    expect(await resolveSegmentCount(criteria2)).toBe(2);
    expect((await resolveSegmentList(criteria2)).map((r) => r.customerId).sort()).toEqual([1, 3]);
  });

  it("balanceMin/balanceMax: يفلتر على currentBalance", async () => {
    await db().insert(s.customers).values([
      { id: 1, name: "مدين كبير", phone: "07701111111", currentBalance: "500000" },
      { id: 2, name: "مدين صغير", phone: "07701111112", currentBalance: "5000" },
      { id: 3, name: "دائن", phone: "07701111113", currentBalance: "-10000" },
    ]);
    const criteria: SegmentCriteria = { balanceMin: "10000" };
    expect(await resolveSegmentCount(criteria)).toBe(1);
    const list = await resolveSegmentList(criteria);
    expect(list.map((r) => r.customerId)).toEqual([1]);

    const criteria2: SegmentCriteria = { balanceMax: "5000" };
    expect((await resolveSegmentList(criteria2)).map((r) => r.customerId).sort()).toEqual([2, 3]);
  });
});

describe("segmentService.resolveSegment — RFM حيّ", () => {
  it("VIP: بالتكرار (≥10 فاتورة) أو بالإنفاق (≥500000) — أيّهما", async () => {
    await db().insert(s.customers).values([
      { id: 1, name: "VIP بالتكرار", phone: "07702000001" },
      { id: 2, name: "VIP بالإنفاق", phone: "07702000002" },
      { id: 3, name: "عادي", phone: "07702000003" },
    ]);
    for (let i = 0; i < 10; i++) await addInvoice({ customerId: 1, total: "10000", daysAgo: i });
    await addInvoice({ customerId: 2, total: "600000", daysAgo: 1 });
    await addInvoice({ customerId: 3, total: "50000", daysAgo: 1 });

    const criteria: SegmentCriteria = { rfm: { preset: "VIP" } };
    const count = await resolveSegmentCount(criteria);
    const list = await resolveSegmentList(criteria);
    expect(count).toBe(2);
    expect(list.map((r) => r.customerId).sort()).toEqual([1, 2]);
  });

  it("AT_RISK: نشاط سابق كافٍ (≥3 فواتير) لكن آخر شراء أقدم من ٦٠ يوماً", async () => {
    await db().insert(s.customers).values([
      { id: 1, name: "في خطر", phone: "07703000001" },
      { id: 2, name: "نشط حديثاً", phone: "07703000002" },
      { id: 3, name: "قليل التكرار قديم", phone: "07703000003" },
    ]);
    // نشاط سابق (٣ فواتير) لكن آخرها منذ ٩٠ يوماً (> ٦٠) ⇒ AT_RISK.
    for (let i = 0; i < 3; i++) await addInvoice({ customerId: 1, total: "10000", daysAgo: 90 + i });
    // نشاط بنفس التكرار لكن حديث (٥ أيام) ⇒ ليس AT_RISK.
    for (let i = 0; i < 3; i++) await addInvoice({ customerId: 2, total: "10000", daysAgo: i + 1 });
    // فاتورة واحدة قديمة فقط (تكرار<٣) ⇒ ليس AT_RISK (يفشل شرط التكرار).
    await addInvoice({ customerId: 3, total: "10000", daysAgo: 90 });

    const criteria: SegmentCriteria = { rfm: { preset: "AT_RISK" } };
    const list = await resolveSegmentList(criteria);
    expect(await resolveSegmentCount(criteria)).toBe(1);
    expect(list.map((r) => r.customerId)).toEqual([1]);
  });

  it("DORMANT: اشترى مرّة على الأقل وآخر شراء أقدم من ١٨٠ يوماً؛ عميل بلا فواتير إطلاقاً لا يُعدّ DORMANT", async () => {
    await db().insert(s.customers).values([
      { id: 1, name: "خامل", phone: "07704000001" },
      { id: 2, name: "بلا فواتير", phone: "07704000002" },
      { id: 3, name: "نشط", phone: "07704000003" },
    ]);
    await addInvoice({ customerId: 1, total: "20000", daysAgo: 200 });
    // customerId=2 بلا أي فاتورة.
    await addInvoice({ customerId: 3, total: "20000", daysAgo: 5 });

    const criteria: SegmentCriteria = { rfm: { preset: "DORMANT" } };
    const list = await resolveSegmentList(criteria);
    expect(await resolveSegmentCount(criteria)).toBe(1);
    expect(list.map((r) => r.customerId)).toEqual([1]);
  });

  it("NEW: أول شراء خلال ٣٠ يوماً", async () => {
    await db().insert(s.customers).values([
      { id: 1, name: "عميل جديد", phone: "07705000001" },
      { id: 2, name: "عميل قديم", phone: "07705000002" },
    ]);
    await addInvoice({ customerId: 1, total: "15000", daysAgo: 5 });
    await addInvoice({ customerId: 2, total: "15000", daysAgo: 60 });

    const criteria: SegmentCriteria = { rfm: { preset: "NEW" } };
    const list = await resolveSegmentList(criteria);
    expect(await resolveSegmentCount(criteria)).toBe(1);
    expect(list.map((r) => r.customerId)).toEqual([1]);
  });

  it("فواتير ملغاة/مرتجعة لا تُحتسَب ضمن RFM", async () => {
    await db().insert(s.customers).values([{ id: 1, name: "فواتير ملغاة فقط", phone: "07706000001" }]);
    await addInvoice({ customerId: 1, total: "10000", daysAgo: 1, status: "CANCELLED" });
    await addInvoice({ customerId: 1, total: "10000", daysAgo: 1, status: "RETURNED" });
    const criteria: SegmentCriteria = { rfm: { minInvoices: 1 } };
    expect(await resolveSegmentCount(criteria)).toBe(0);
  });
});

describe("segmentService.resolveSegment — استبعاد حتميّ (OPTED_OUT/هاتف/تعطيل)", () => {
  it("عميل OPTED_OUT لا يظهر أبداً حتى لو طابق كل معايير VIP بدقّة", async () => {
    await db().insert(s.customers).values([{ id: 1, name: "VIP لكن رافض", phone: "07707000001", waConsent: "OPTED_OUT" }]);
    for (let i = 0; i < 10; i++) await addInvoice({ customerId: 1, total: "10000", daysAgo: i });

    const criteria: SegmentCriteria = { rfm: { preset: "VIP" } };
    expect(await resolveSegmentCount(criteria)).toBe(0);
    expect(await resolveSegmentList(criteria)).toHaveLength(0);

    // وحتى بلا أي معيار RFM إطلاقاً (شريحة عامة بلا فلاتر) — يبقى مستبعَداً.
    expect(await resolveSegmentCount({})).toBe(0);
  });

  it("عميل بلا هاتف أو برقم قصير جداً يُستبعَد", async () => {
    await db().insert(s.customers).values([
      { id: 1, name: "بلا هاتف", phone: null },
      { id: 2, name: "هاتف قصير", phone: "123" },
      { id: 3, name: "هاتف صالح", phone: "07708000003" },
    ]);
    expect(await resolveSegmentCount({})).toBe(1);
    const list = await resolveSegmentList({});
    expect(list.map((r) => r.customerId)).toEqual([3]);
  });

  it("عميل مُعطَّل (isActive=false) يُستبعَد", async () => {
    await db().insert(s.customers).values([
      { id: 1, name: "مُعطَّل", phone: "07709000001", isActive: false },
      { id: 2, name: "نشط", phone: "07709000002", isActive: true },
    ]);
    expect(await resolveSegmentCount({})).toBe(1);
    expect((await resolveSegmentList({})).map((r) => r.customerId)).toEqual([2]);
  });

  it("requireOptIn: افتراضياً يشمل UNKNOWN؛ true يستبعده (يبقى OPTED_IN فقط)", async () => {
    await db().insert(s.customers).values([
      { id: 1, name: "غير محدّد", phone: "07710000001", waConsent: "UNKNOWN" },
      { id: 2, name: "موافق صراحة", phone: "07710000002", waConsent: "OPTED_IN" },
    ]);
    expect(await resolveSegmentCount({})).toBe(2);
    const strict = await resolveSegmentList({ requireOptIn: true });
    expect(strict.map((r) => r.customerId)).toEqual([2]);
  });
});

describe("segmentService.resolveSegment — عزل الفرع", () => {
  it("RFM يُحتسَب من فواتير الفرع المطلوب فقط", async () => {
    await db().insert(s.customers).values([{ id: 1, name: "متعدّد الفروع", phone: "07711000001" }]);
    // ٥ فواتير على الفرع ١، فاتورة واحدة على الفرع ٢.
    for (let i = 0; i < 5; i++) await addInvoice({ customerId: 1, branchId: 1, total: "10000", daysAgo: i });
    await addInvoice({ customerId: 1, branchId: 2, total: "10000", daysAgo: 1 });

    // على الفرع ١: تكرار=٥ يكفي minInvoices=5.
    expect(await resolveSegmentCount({ branchId: 1, rfm: { minInvoices: 5 } })).toBe(1);
    // على الفرع ٢: تكرار=١ فقط ⇒ لا يكفي.
    expect(await resolveSegmentCount({ branchId: 2, rfm: { minInvoices: 5 } })).toBe(0);
    // بلا عزل فرع: تكرار الكلّي=٦ يكفي أيضاً.
    expect(await resolveSegmentCount({ rfm: { minInvoices: 5 } })).toBe(1);
  });
});
