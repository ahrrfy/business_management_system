/**
 * Idempotency طلب التسوية اليدويّ (P2-#1، تقرير المراجعة ٢٥/٨).
 *
 * قبل الإصلاح: إعادةُ الشاشة إرسالَ نفس العملية (نقرٌ مضاعف، انقطاعُ شبكة) تُنشئ طلبَين
 * معلَّقَين متطابقَين. اعتمادُهما لاحقاً بالخطأ = **مضاعفةُ تسوية** (حركةٌ واحدة كمّياً، لكن مالياً
 * قيدَان). الإصلاح: مفتاح تكرارٍ من العميل + بصمةُ حمولةٍ ⇒
 *   • نفس المفتاح + نفس الحمولة ⇒ إعادةُ الطلب الأول (لا صفٌّ جديد، لا إشعارٌ ثانٍ).
 *   • نفس المفتاح + حمولةٌ مختلفة ⇒ CONFLICT (بصمةُ الحمولة تختلف).
 */
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { requestStockAdjustment } from "../inventory/adjustmentApproval";

const TABLES = [
  "idempotencyKeys",
  "stockAdjustmentRequests",
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

async function seed() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values({
    id: 1,
    openId: "u-admin",
    name: "أدمن",
    role: "admin",
    loginMethod: "local",
    branchId: 1,
  });
  await d.insert(s.products).values({ id: 1, name: "قلم" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "PEN-1", costPrice: "100.00" });
  await d.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 10 });
}

async function countRequests(): Promise<number> {
  const r = await db().select({ c: sql<number>`COUNT(*)` }).from(s.stockAdjustmentRequests);
  return Number(r[0]?.c ?? 0);
}

const actor = { userId: 1, branchId: 1, role: "admin" };

beforeEach(async () => {
  await reset();
  await seed();
});

describe("Idempotency طلب التسوية (P2-#1)", () => {
  it("بلا clientRequestId ⇒ كلّ نداء يُنشئ صفّاً جديداً (السلوك الأصلي محفوظ)", async () => {
    const a = await requestStockAdjustment({ variantId: 1, branchId: 1, targetQuantity: 12 }, actor);
    const b = await requestStockAdjustment({ variantId: 1, branchId: 1, targetQuantity: 12 }, actor);
    expect(a.requestId).not.toBe(b.requestId);
    expect(await countRequests()).toBe(2);
    expect(a.idempotentReplay).toBeUndefined();
    expect(b.idempotentReplay).toBeUndefined();
  });

  it("نفس clientRequestId + نفس الحمولة ⇒ replay صامت (طلبٌ واحد)", async () => {
    const key = "adj-req-abcd1234";
    const a = await requestStockAdjustment(
      { variantId: 1, branchId: 1, targetQuantity: 12, clientRequestId: key },
      actor,
    );
    const b = await requestStockAdjustment(
      { variantId: 1, branchId: 1, targetQuantity: 12, clientRequestId: key },
      actor,
    );
    expect(b.requestId).toBe(a.requestId);
    expect(b.idempotentReplay).toBe(true);
    // ثابتُ الحماية الأساسيّ: صفٌّ واحد فقط في stockAdjustmentRequests رغم نداءَين.
    expect(await countRequests()).toBe(1);
  });

  it("نفس المفتاح بحمولةٍ مختلفة ⇒ CONFLICT (بصمةُ الحمولة تختلف)", async () => {
    const key = "adj-req-mismatch-1";
    await requestStockAdjustment(
      { variantId: 1, branchId: 1, targetQuantity: 12, clientRequestId: key },
      actor,
    );
    // نفس المفتاح لكن الكمية تختلف ⇒ الخدمة ترفض بدل ابتلاعٍ صامت.
    await expect(
      requestStockAdjustment(
        { variantId: 1, branchId: 1, targetQuantity: 5, clientRequestId: key },
        actor,
      ),
    ).rejects.toThrow(/بحمولةٍ مختلفة/);
    expect(await countRequests()).toBe(1);
  });

  it("الملاحظاتُ جزءٌ من الحمولة — تغييرها بنفس المفتاح ⇒ CONFLICT", async () => {
    const key = "adj-req-notes-1";
    await requestStockAdjustment(
      { variantId: 1, branchId: 1, targetQuantity: 12, notes: "تلف بالنقل", clientRequestId: key },
      actor,
    );
    await expect(
      requestStockAdjustment(
        { variantId: 1, branchId: 1, targetQuantity: 12, notes: "سرقة", clientRequestId: key },
        actor,
      ),
    ).rejects.toThrow(/بحمولةٍ مختلفة/);
  });

  it("مفتاحان مختلفان بنفس الحمولة ⇒ طلبان مستقلّان (كما كان)", async () => {
    const a = await requestStockAdjustment(
      { variantId: 1, branchId: 1, targetQuantity: 12, clientRequestId: "key-1" },
      actor,
    );
    const b = await requestStockAdjustment(
      { variantId: 1, branchId: 1, targetQuantity: 12, clientRequestId: "key-2" },
      actor,
    );
    expect(a.requestId).not.toBe(b.requestId);
    expect(await countRequests()).toBe(2);
  });
});

describe("P2-#3: سببُ التسوية ومرفق الإثبات", () => {
  const SAMPLE_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAeImBZsAAAAASUVORK5CYII=";

  it("قبولٌ بلا سبب/مرفق (توافقٌ خلفيّ — مسار الاختبار القائم)", async () => {
    const r = await requestStockAdjustment(
      { variantId: 1, branchId: 1, targetQuantity: 12 },
      actor,
    );
    expect(r.requestId).toBeGreaterThan(0);
  });

  it("رفضٌ صريح لسببٍ حسّاس بلا مرفق: DAMAGE", async () => {
    await expect(
      requestStockAdjustment(
        { variantId: 1, branchId: 1, targetQuantity: 12, reason: "DAMAGE" },
        actor,
      ),
    ).rejects.toThrow(/مرفقَ إثبات/);
  });

  it("رفضٌ لسببٍ حسّاس بلا مرفق: LOSS", async () => {
    await expect(
      requestStockAdjustment(
        { variantId: 1, branchId: 1, targetQuantity: 12, reason: "LOSS" },
        actor,
      ),
    ).rejects.toThrow(/مرفقَ إثبات/);
  });

  it("قبول DAMAGE مع مرفق صالح — يحفظ الاثنين", async () => {
    const r = await requestStockAdjustment(
      { variantId: 1, branchId: 1, targetQuantity: 12, reason: "DAMAGE", attachmentUrl: SAMPLE_PNG },
      actor,
    );
    expect(r.requestId).toBeGreaterThan(0);
  });

  it("قبول CORRECTION بلا مرفق (غير حسّاس)", async () => {
    const r = await requestStockAdjustment(
      { variantId: 1, branchId: 1, targetQuantity: 12, reason: "CORRECTION" },
      actor,
    );
    expect(r.requestId).toBeGreaterThan(0);
  });

  it("رفض مرفق غير صالح (نصّ خامّ لا data URL)", async () => {
    await expect(
      requestStockAdjustment(
        { variantId: 1, branchId: 1, targetQuantity: 12, reason: "DAMAGE", attachmentUrl: "not-a-data-url" },
        actor,
      ),
    ).rejects.toThrow(/data URL/);
  });

  it("رفض مرفق بصيغة PDF (نوعٌ غير مدعوم بالعرض)", async () => {
    await expect(
      requestStockAdjustment(
        { variantId: 1, branchId: 1, targetQuantity: 12, reason: "DAMAGE", attachmentUrl: "data:application/pdf;base64,AAAA" },
        actor,
      ),
    ).rejects.toThrow(/JPEG|PNG|WebP|GIF|data URL/);
  });

  it("Idempotency: تغيير السبب على نفس المفتاح ⇒ CONFLICT (السبب جزءٌ من البصمة)", async () => {
    const key = "adj-key-reason-1";
    await requestStockAdjustment(
      { variantId: 1, branchId: 1, targetQuantity: 12, reason: "CORRECTION", clientRequestId: key },
      actor,
    );
    await expect(
      requestStockAdjustment(
        { variantId: 1, branchId: 1, targetQuantity: 12, reason: "STOCK_TAKE", clientRequestId: key },
        actor,
      ),
    ).rejects.toThrow(/بحمولةٍ مختلفة/);
  });
});
