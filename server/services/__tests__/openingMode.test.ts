// «وضع الافتتاح» (الافتتاح التدريجي ١٨/٧) — ش١: الإعدادات والحوكمة + ختم openedAt المركزي في setStock
// + علَم الهدف السالب (للجرد الافتتاحي) + مؤشر تقدّم الافتتاح.
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { withTx } from "../tx";
import { setStock } from "../inventoryService";
import { getOpeningMode, getOpeningProgress, updateOpeningMode } from "../openingModeService";

const ADMIN = { userId: 1 };
const DAY_MS = 86_400_000;

const TABLES = [
  "openingModeSettings",
  "inventoryMovements",
  "branchStock",
  "productVariants",
  "products",
  "users",
  "branches",
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
async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([{ id: 1, openId: "u_admin", name: "المدير", role: "admin", branchId: 1 }]);
  await d.insert(s.products).values({ id: 1, name: "دفتر ٦٠ ورقة" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "NB-60", costPrice: "500.00" });
}
beforeEach(async () => {
  await reset();
  await seedBase();
});

function futureYmd(days: number): string {
  return new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);
}

async function expectTrpc(p: Promise<unknown>, code: string, msgRe: RegExp) {
  try {
    await p;
    expect.fail("كان يجب أن يُرفض");
  } catch (e) {
    expect(e).toBeInstanceOf(TRPCError);
    expect((e as TRPCError).code).toBe(code);
    expect((e as TRPCError).message).toMatch(msgRe);
  }
}

async function openedAtOf(variantId: number, branchId: number): Promise<Date | null> {
  const [r] = await db()
    .select({ openedAt: s.branchStock.openedAt })
    .from(s.branchStock)
    .where(and(eq(s.branchStock.variantId, variantId), eq(s.branchStock.branchId, branchId)));
  return r?.openedAt ?? null;
}

describe("وضع الافتتاح — الإعدادات والحوكمة", () => {
  it("القراءة قبل أي ضبط تعيد الافتراضي (مطفأ/غير فعّال) ولا تكتب صفّاً (get-or-default)", async () => {
    const view = await getOpeningMode();
    expect(view.enabled).toBe(false);
    expect(view.active).toBe(false);
    expect(view.endsAt).toBeNull();
    expect(view.maxNegativeQtyPerLine).toBe(100);
    const rows = await db().select().from(s.openingModeSettings);
    expect(rows.length).toBe(0); // مسار القراءة لا يكتب
  });

  it("التفعيل بلا تاريخ انتهاء يُرفض — نافذة بلا سقف مرفوضة", async () => {
    await expectTrpc(updateOpeningMode({ enabled: true }, ADMIN), "BAD_REQUEST", /تاريخ انتهاء/);
  });

  it("التفعيل بتاريخ أبعد من ٦٠ يوماً يُرفض", async () => {
    await expectTrpc(
      updateOpeningMode({ enabled: true, endsAtYmd: futureYmd(61) }, ADMIN),
      "BAD_REQUEST",
      /60/,
    );
  });

  it("التفعيل بتاريخ ماضٍ يُرفض", async () => {
    const past = new Date(Date.now() - 3 * DAY_MS).toISOString().slice(0, 10);
    await expectTrpc(
      updateOpeningMode({ enabled: true, endsAtYmd: past }, ADMIN),
      "BAD_REQUEST",
      /اليوم أو مستقبلاً/,
    );
  });

  it("تفعيل صحيح: active=true وendsAtYmd يعود كما أُدخل (بلا انزياح يوم عند إعادة الحفظ)", async () => {
    const ymd = futureYmd(10);
    const { before, after } = await updateOpeningMode(
      { enabled: true, endsAtYmd: ymd, maxNegativeQtyPerLine: 50 },
      ADMIN,
    );
    expect(before.enabled).toBe(false);
    expect(after.enabled).toBe(true);
    expect(after.active).toBe(true);
    expect(after.endsAtYmd).toBe(ymd); // ذهاب-إياب بلا انزياح
    expect(after.maxNegativeQtyPerLine).toBe(50);
    // endsAt المخزَّن حدّ حصري = اليوم التالي 00:00 UTC.
    expect(after.endsAt).toBe(`${new Date(Date.parse(`${ymd}T00:00:00Z`) + DAY_MS).toISOString()}`);
    // إعادة حفظ بنفس endsAtYmd لا تمدّد النافذة.
    const again = await updateOpeningMode({ enabled: true, endsAtYmd: after.endsAtYmd!, maxNegativeQtyPerLine: 50 }, ADMIN);
    expect(again.after.endsAt).toBe(after.endsAt);
  });

  it("انقضاء endsAt يطفئ الفعالية حكماً (enabled=true لكن active=false)", async () => {
    await db().insert(s.openingModeSettings).values({
      id: 1,
      enabled: true,
      endsAt: new Date(Date.now() - DAY_MS),
      maxNegativeQtyPerLine: 100,
    });
    const view = await getOpeningMode();
    expect(view.enabled).toBe(true);
    expect(view.active).toBe(false);
  });

  it("الإطفاء يصفّر النافذة ويُطفئ الفعالية فوراً", async () => {
    await updateOpeningMode({ enabled: true, endsAtYmd: futureYmd(7) }, ADMIN);
    const { after } = await updateOpeningMode({ enabled: false }, ADMIN);
    expect(after.enabled).toBe(false);
    expect(after.active).toBe(false);
    expect(after.endsAt).toBeNull();
  });

  it("سقف كمية السطر خارج [1..10000] يُرفض", async () => {
    await expectTrpc(
      updateOpeningMode({ enabled: true, endsAtYmd: futureYmd(7), maxNegativeQtyPerLine: 0 }, ADMIN),
      "BAD_REQUEST",
      /بين 1 و10000/,
    );
    await expectTrpc(
      updateOpeningMode({ enabled: true, endsAtYmd: futureYmd(7), maxNegativeQtyPerLine: 10001 }, ADMIN),
      "BAD_REQUEST",
      /بين 1 و10000/,
    );
  });
});

describe("ختم openedAt المركزي في setStock (مرجع OPENING)", () => {
  it("تسوية بمرجع OPENING تختم openedAt — وتصون تاريخ الافتتاح الأول عند التكرار (idempotent)", async () => {
    await withTx((tx) =>
      setStock(tx, { variantId: 1, branchId: 1, targetQuantity: 30, referenceType: "OPENING", createdBy: 1 }),
    );
    const first = await openedAtOf(1, 1);
    expect(first).not.toBeNull();

    // إعادة تشغيل (نمط البذرة idempotent) — الكمية تتحدّث لكن openedAt الأول يُصان (COALESCE).
    await new Promise((r) => setTimeout(r, 1100)); // فارق ثانية ليتمايز الختمان لو أُعيد خطأً
    await withTx((tx) =>
      setStock(tx, { variantId: 1, branchId: 1, targetQuantity: 45, referenceType: "OPENING", createdBy: 1 }),
    );
    const second = await openedAtOf(1, 1);
    expect(second?.getTime()).toBe(first!.getTime());
  });

  it("تسوية عادية (بلا مرجع OPENING) لا تختم openedAt", async () => {
    await withTx((tx) => setStock(tx, { variantId: 1, branchId: 1, targetQuantity: 12, createdBy: 1 }));
    expect(await openedAtOf(1, 1)).toBeNull();
  });

  it("هدف سالب: مرفوض افتراضياً — ومسموح بعلَم allowNegativeTarget (مسار الجرد الافتتاحي حصراً)", async () => {
    await expectTrpc(
      withTx((tx) => setStock(tx, { variantId: 1, branchId: 1, targetQuantity: -5, referenceType: "OPENING" })),
      "BAD_REQUEST",
      /غير سالب/,
    );

    const res = await withTx((tx) =>
      setStock(tx, {
        variantId: 1,
        branchId: 1,
        targetQuantity: -5,
        referenceType: "OPENING",
        allowNegativeTarget: true,
        createdBy: 1,
      }),
    );
    expect(res.newQuantity).toBe(-5);
    expect(res.delta).toBe(-5);
    const [bs] = await db()
      .select({ q: s.branchStock.quantity, openedAt: s.branchStock.openedAt })
      .from(s.branchStock)
      .where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 1)));
    expect(Number(bs.q)).toBe(-5);
    expect(bs.openedAt).not.toBeNull(); // فُتتح برصيده السالب الحقيقي — يظهر في تقرير السوالب
    const [mv] = await db().select().from(s.inventoryMovements).where(eq(s.inventoryMovements.id, res.movementId));
    expect(mv.movementType).toBe("ADJUST");
    expect(Number(mv.quantity)).toBe(5); // مطلقة — الإشارة في علامة «(فرق −٥)»
    expect(String(mv.notes)).toContain("(فرق -5)");
  });
});

describe("مؤشر تقدّم الافتتاح «X من Y مُفتتَح»", () => {
  it("الإجمالي من المتغيّرات الفعّالة (يستثني الخدمي والبكج وغير الفعّال) والصنف بلا صفّ رصيد يُعدّ غير مُفتتَح", async () => {
    const d = db();
    // متغيّر ثانٍ للمنتج العادي بلا أي صفّ branchStock (لم يُبَع قط) — يجب أن يُحسب في الإجمالي.
    await d.insert(s.productVariants).values({ id: 2, productId: 1, sku: "NB-60-B", costPrice: "500.00" });
    // منتج خدمي + بكج + معطَّل — كلها خارج الإجمالي.
    await d.insert(s.products).values([
      { id: 2, name: "تصميم", isService: true },
      { id: 3, name: "بكج قرطاسية", isBundle: true },
      { id: 4, name: "قديم", isActive: false },
    ]);
    await d.insert(s.productVariants).values([
      { id: 3, productId: 2, sku: "SRV-1" },
      { id: 4, productId: 3, sku: "BND-1" },
      { id: 5, productId: 4, sku: "OLD-1" },
    ]);

    // افتتاح المتغيّر ١ في الفرع ١ فقط.
    await withTx((tx) =>
      setStock(tx, { variantId: 1, branchId: 1, targetQuantity: 10, referenceType: "OPENING", createdBy: 1 }),
    );

    const progress = await getOpeningProgress();
    const b1 = progress.find((p) => p.branchId === 1)!;
    const b2 = progress.find((p) => p.branchId === 2)!;
    expect(b1.totalVariants).toBe(2); // NB-60 + NB-60-B فقط
    expect(b2.totalVariants).toBe(2);
    expect(b1.openedVariants).toBe(1);
    expect(b2.openedVariants).toBe(0);
  });

  it("بضاعة الأمانة مُستبعَدة من المؤشر بسطاً ومقاماً (تُفتتَح بالإيداع لا بالجرد) — §٥-د", async () => {
    const d = db();
    // صنف أمانة برصيد مُفتتَح (كأنه أُودِع، openedAt غير فارغ) — يجب ألّا يظهر في الإجمالي ولا المُفتتَح،
    // وإلا لن يبلغ المؤشر ١٠٠٪ أبداً (صنف الأمانة لا «يُفتتَح» بالجرد الافتتاحيّ الذي يستبعده أصلاً).
    await d.insert(s.products).values({ id: 5, name: "ملزمة أمانة", isConsignment: true });
    await d.insert(s.productVariants).values({ id: 6, productId: 5, sku: "CNS-1", costPrice: "400.00" });
    await d.insert(s.branchStock).values({ variantId: 6, branchId: 1, quantity: 10, openedAt: new Date() });

    const progress = await getOpeningProgress();
    const b1 = progress.find((p) => p.branchId === 1)!;
    expect(b1.totalVariants).toBe(1); // الصنف العادي فقط (variant 1) — الأمانة خارج المقام
    expect(b1.openedVariants).toBe(0); // الأمانة المُفتتَحة خارج البسط أيضاً
  });
});
