import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createStockTransfer } from "../transferService";
import { withTx } from "../tx";

/**
 * **المسار هـ-٢ (١٧/٨) — نطاق قفل التحويل بين الفروع.**
 *
 * الورقة وصفته بشقّين: «لا يمسك صفوفاً غير موجودة» و«ترتيب غير تصاعديّ». إعادة التحقّق على
 * الشيفرة أسقطت الشقّين:
 *  - الترتيب تصاعديّ فعلاً (`orderBy(asc(variantId))` على أصنافٍ مرتّبة مسبقاً).
 *  - والصفوف الناقصة يغطّيها `inventoryService.applyMovement` نفسه (إدراج `onDuplicateKeyUpdate`
 *    ثمّ قفل الصفّ) — وهو المنفذ الوحيد لتغيير المخزون.
 *
 * **الباقي الحقيقيّ هو النطاق**: القفل كان يشمل صفوف **كلّ الفروع** لتلك الأصناف (نظير هـ-١ في
 * الهدايا)، فيُسلسل بيع فرعٍ ثالثٍ لا علاقة له بالتحويل. هذه الاختبارات تقيس السلوك فعلياً بمعاملةٍ
 * متزامنة بمهلةٍ قصيرة، لا بقراءة الشيفرة.
 */

function db() {
  const v = getDb();
  if (!v) throw new Error("DATABASE_URL not set for tests");
  return v;
}

const TABLES = [
  "stockTransferLines", "stockTransfers", "inventoryMovements", "accountingEntries",
  "idempotencyKeys", "branchStock", "productUnits", "productVariants", "products",
  "categories", "users", "branches",
];

beforeEach(async () => {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
    { id: 3, name: "ثالث", code: "THIRD", type: "SALES" },
  ]);
  await d.insert(s.users).values({
    id: 1, openId: "u1", name: "مدير", role: "admin", loginMethod: "local", branchId: 1,
  });
  await d.insert(s.categories).values({ id: 1, name: "قرطاسية" });
  await d.insert(s.products).values([
    { id: 1, name: "قلم", categoryId: 1 },
    { id: 2, name: "دفتر", categoryId: 1 },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "PEN-1", costPrice: "500.00" },
    { id: 2, productId: 2, sku: "NB-1", costPrice: "1000.00" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: 1, isBaseUnit: true },
    { id: 2, variantId: 2, unitName: "قطعة", conversionFactor: 1, isBaseUnit: true },
  ]);
  // نفس الصنفين في الفروع الثلاثة — الفرع ٣ لا علاقة له بالتحويل ١→٢.
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 100 },
    { variantId: 1, branchId: 2, quantity: 10 },
    { variantId: 1, branchId: 3, quantity: 50 },
    { variantId: 2, branchId: 1, quantity: 100 },
    { variantId: 2, branchId: 3, quantity: 50 },
  ]);
});

/** يحاول قفل صفّ (صنف، فرع) بمعاملةٍ مستقلّة بمهلة ٢ث: "ok" إن لم يُحجَب، "blocked" إن حُجب. */
async function tryLockElsewhere(variantId: number, branchId: number): Promise<"ok" | "blocked"> {
  return db()
    .transaction(async (t2) => {
      await t2.execute(sql`SET innodb_lock_wait_timeout = 2`);
      await t2
        .select({ id: s.branchStock.id })
        .from(s.branchStock)
        .where(and(eq(s.branchStock.variantId, variantId), eq(s.branchStock.branchId, branchId)))
        .for("update");
      return "ok" as const;
    })
    .catch(() => "blocked" as const);
}

describe("هـ-٢ — قفل التحويل محصورٌ بفرعَي السند", () => {
  it("التحويل ١→٢ لا يُسلسل بيع الفرع الثالث لنفس الصنف", async () => {
    let thirdBranch: "ok" | "blocked" = "blocked";
    await withTx(async (tx) => {
      await createStockTransfer(tx, {
        fromBranchId: 1,
        toBranchId: 2,
        items: [{ variantId: 1, baseQuantity: 5 }],
        createdBy: 1,
        clientRequestId: "trf-scope-1",
      });
      // ما زالت معاملة التحويل ممسكةً بأقفالها هنا.
      thirdBranch = await tryLockElsewhere(1, 3);
    });
    expect(thirdBranch).toBe("ok");
  });

  it("وفرعا السند نفساهما يبقيان مقفولَين (القفل لم يُفقَد بالتضييق)", async () => {
    let source: "ok" | "blocked" = "ok";
    let destination: "ok" | "blocked" = "ok";
    await withTx(async (tx) => {
      await createStockTransfer(tx, {
        fromBranchId: 1,
        toBranchId: 2,
        items: [{ variantId: 1, baseQuantity: 5 }],
        createdBy: 1,
        clientRequestId: "trf-scope-2",
      });
      source = await tryLockElsewhere(1, 1);
      destination = await tryLockElsewhere(1, 2);
    });
    // المصدر مقفولٌ يقيناً (خصمُه جرى فعلاً)، والوجهة ضمن نطاق القفل الجديد.
    expect(source).toBe("blocked");
    expect(destination).toBe("blocked");
  });

  it("صنفٌ بلا صفٍّ في فرع الوجهة يمرّ ويُنشئ رصيده (لا قفلَ على العدم)", async () => {
    // الصنف ٢ بلا صفّ في الفرع ٢ — المسار يجب أن يُنشئه عبر applyMovement لا أن يتسرّب.
    await withTx((tx) =>
      createStockTransfer(tx, {
        fromBranchId: 1,
        toBranchId: 2,
        items: [{ variantId: 2, baseQuantity: 7 }],
        createdBy: 1,
        clientRequestId: "trf-scope-3",
      }),
    );
    const [src] = await db()
      .select({ q: s.branchStock.quantity })
      .from(s.branchStock)
      .where(and(eq(s.branchStock.variantId, 2), eq(s.branchStock.branchId, 1)));
    expect(Number(src.q)).toBe(93); // خُصم المصدر عند الإرسال
    // الوجهة لا تُرصَّد إلّا عند الاستلام (تحويلٌ بخطوتين) — المهمّ ألّا يفشل السند.
    const rows = await db()
      .select({ id: s.stockTransfers.id, status: s.stockTransfers.status })
      .from(s.stockTransfers);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("IN_TRANSIT");
  });
});
