/**
 * ═══ اختبار محرّك العكس الواحد — القانون ق٧ (شريحة ٠٣٢٩) ═══
 *
 * الثابتُ المحروس: بعد `reverse()` مستند، مجموعُ الأثر لكل (documentType, documentId,
 * effectKind) يعود إلى صفر (`signedAmount` و`signedQuantity` معاً). الاختبار عشوائيّ ببذرةٍ
 * ثابتة — يولّد آثاراً مختلطةً على أنواع كثيرة ثمّ يعكسها ويؤكّد التوازن.
 */
import Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { documentEffects } from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  assertReversalBalancedTx,
  recordEffect,
  reverse,
  summarizeEffects,
} from "../reversalEngine";
import { withTx, type Actor } from "../tx";
import type {
  DocumentEffectKind,
  DocumentType,
} from "@shared/documentEffects";

function db() {
  const database = getDb();
  if (!database) throw new Error("DATABASE_URL not set for tests");
  return database;
}

const ACTOR: Actor = { userId: 1, branchId: 1, role: "admin", isOwner: true };

/** بذرةٌ ثابتة — Xorshift32؛ ما يكفي لتوليدٍ تكراريٍّ يُعاد إنتاجه بلا اعتماد على تنفيذ Node. */
function seededRng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    // اجعل الخرج في [0,1)
    return ((state >>> 0) % 1_000_000) / 1_000_000;
  };
}

const AMOUNT_KINDS: readonly DocumentEffectKind[] = [
  "LEDGER_ENTRY",
  "CUSTOMER_BALANCE",
  "SUPPLIER_BALANCE",
  "DELIVERY_CUSTODY",
  "PAID_AMOUNT",
  "COMMISSION",
  "DEPOSIT",
  "COUPON",
  "GIFT",
  "INSTALLMENT",
  "CARD",
  "CONSIGNMENT",
  "ROUNDING",
];

const QUANTITY_KINDS: readonly DocumentEffectKind[] = ["INVENTORY"];

beforeEach(async () => {
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  await db().execute(sql`TRUNCATE TABLE documentEffects`);
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
});

describe("reversalEngine — الثابت Σ=0 على نطاقٍ كامل", () => {
  it("مجموعُ الأثر يعود صفراً لكلّ نوعٍ بعد العكس الكامل (بذرة عشوائية ثابتة)", async () => {
    const documentType: DocumentType = "INVOICE";
    const documentId = 12345;
    const rng = seededRng(0xc0ffee37);

    // ═══ ١) ولّد بين ١٥ و٢٥ أثراً على أنواعٍ مختلطة ═══
    await withTx(async (tx) => {
      const eventCount = 15 + Math.floor(rng() * 10);
      for (let i = 0; i < eventCount; i++) {
        const isQty = rng() < 0.3; // ٣٠٪ حركات مخزون، ٧٠٪ مالية
        const kind = isQty
          ? QUANTITY_KINDS[Math.floor(rng() * QUANTITY_KINDS.length)]
          : AMOUNT_KINDS[Math.floor(rng() * AMOUNT_KINDS.length)];
        // مبلغٌ عشوائيّ بأربع منازل داخل [-2500, +2500].
        const amt = new Decimal(rng() * 5000 - 2500).toDecimalPlaces(4).toString();
        // كمّيةٌ صحيحة داخل [-25, +25].
        const qty = Math.round(rng() * 50 - 25);
        await recordEffect(
          tx,
          {
            documentType,
            documentId,
            effectKind: kind,
            effectTable: "synthetic",
            effectRowId: i + 1,
            signedAmount: amt,
            signedQuantity: kind === "INVENTORY" ? qty : 0,
            branchId: 1,
            reason: `synthetic-${i}`,
            payloadJson: { i },
          },
          ACTOR,
        );
      }
    });

    // ═══ ٢) اقرأ الصفوف — كلها APPLY بلا REVERSE بعد ═══
    const applyRows = await db()
      .select({ id: documentEffects.id })
      .from(documentEffects)
      .where(
        and(
          eq(documentEffects.documentType, documentType),
          eq(documentEffects.documentId, documentId),
          eq(documentEffects.phase, "APPLY"),
        ),
      );
    expect(applyRows.length).toBeGreaterThanOrEqual(15);

    // ═══ ٣) اعكس الكلّ ═══
    const outcome = await withTx((tx) =>
      reverse(tx, documentType, documentId, { kind: "ALL" }, "اختبار العكس الكامل", ACTOR),
    );
    expect(outcome.reversedCount).toBe(applyRows.length);

    // ═══ ٤) الثابتُ المحروس: Σ لكلّ (docId, kind) = 0 ═══
    await withTx(async (tx) => {
      await assertReversalBalancedTx(tx, documentType, documentId, { kind: "ALL" });
    });

    // ═══ ٥) ولو تحقّقتَه من جدولٍ للتلخيص، كلّ نوعٍ فيه صفّان (APPLY + REVERSE) بمجموعٍ متعاكس ═══
    const summary = await withTx((tx) => summarizeEffects(tx, documentType, documentId));
    const byKind: Record<string, { apply: number; reverse: number }> = {};
    for (const row of summary) {
      byKind[row.effectKind] ??= { apply: 0, reverse: 0 };
      if (row.phase === "APPLY") byKind[row.effectKind].apply = Number(row.sumAmount);
      if (row.phase === "REVERSE") byKind[row.effectKind].reverse = Number(row.sumAmount);
    }
    for (const [, s] of Object.entries(byKind)) {
      const sum = new Decimal(s.apply).plus(s.reverse).toDecimalPlaces(4);
      expect(sum.toString()).toBe("0");
    }
  });

  it("العكسُ على نطاقٍ محدَّد يترك بقيّة الأنواع كما هي", async () => {
    const documentType: DocumentType = "PURCHASE_ORDER";
    const documentId = 999;

    await withTx(async (tx) => {
      await recordEffect(
        tx,
        {
          documentType,
          documentId,
          effectKind: "SUPPLIER_BALANCE",
          effectTable: "suppliers",
          effectRowId: 5,
          signedAmount: "1500.0000",
          branchId: 1,
          reason: "شراء آجل",
        },
        ACTOR,
      );
      await recordEffect(
        tx,
        {
          documentType,
          documentId,
          effectKind: "INVENTORY",
          effectTable: "inventoryMovements",
          effectRowId: 10,
          signedQuantity: 100,
          branchId: 1,
          reason: "استلام",
        },
        ACTOR,
      );
    });

    // اعكس رصيد المورّد فقط
    await withTx((tx) =>
      reverse(
        tx,
        documentType,
        documentId,
        { kind: "ONLY", effectKinds: ["SUPPLIER_BALANCE"] },
        "إلغاء الفاتورة",
        ACTOR,
      ),
    );

    // النطاق المعكوس متوازن
    await withTx((tx) =>
      assertReversalBalancedTx(
        tx,
        documentType,
        documentId,
        { kind: "ONLY", effectKinds: ["SUPPLIER_BALANCE"] },
      ),
    );

    // INVENTORY لم يُعكَس ⇒ لا يزال APPLY مفتوحاً
    const inventoryRows = await db()
      .select({ id: documentEffects.id, phase: documentEffects.phase })
      .from(documentEffects)
      .where(
        and(
          eq(documentEffects.documentType, documentType),
          eq(documentEffects.documentId, documentId),
          eq(documentEffects.effectKind, "INVENTORY"),
        ),
      );
    expect(inventoryRows.length).toBe(1);
    expect(inventoryRows[0]!.phase).toBe("APPLY");
  });

  it("يفشلُ بلا سببٍ للعكس", async () => {
    await withTx(async (tx) => {
      await recordEffect(
        tx,
        {
          documentType: "INVOICE",
          documentId: 42,
          effectKind: "PAID_AMOUNT",
          signedAmount: "100.00",
          branchId: 1,
        },
        ACTOR,
      );
    });

    await expect(
      withTx((tx) => reverse(tx, "INVOICE", 42, { kind: "ALL" }, "  ", ACTOR)),
    ).rejects.toThrow(/سببُ العكس/);
  });

  it("العكسُ على مستندٍ بلا آثار = صفر عمليات (idempotent)", async () => {
    const result = await withTx((tx) =>
      reverse(tx, "INVOICE", 77777, { kind: "ALL" }, "لا شيء لعكسه", ACTOR),
    );
    expect(result.reversedCount).toBe(0);
    expect(result.reversedEffectIds).toEqual([]);
  });

  it("العكسُ مرّتين لا يزيد بقيّةً — كلّ APPLY يقابله REVERSE واحد", async () => {
    await withTx(async (tx) => {
      await recordEffect(
        tx,
        {
          documentType: "INVOICE",
          documentId: 8888,
          effectKind: "PAID_AMOUNT",
          signedAmount: "250.00",
          branchId: 1,
        },
        ACTOR,
      );
    });
    const first = await withTx((tx) =>
      reverse(tx, "INVOICE", 8888, { kind: "ALL" }, "الأولى", ACTOR),
    );
    expect(first.reversedCount).toBe(1);
    // نداءٌ ثانٍ لا يجد أيَّ APPLY بلا مقابل ⇒ صفر
    const second = await withTx((tx) =>
      reverse(tx, "INVOICE", 8888, { kind: "ALL" }, "الثانية", ACTOR),
    );
    expect(second.reversedCount).toBe(0);
    // مجموعُ الصفوف = ٢ فقط
    const rows = await db()
      .select({ id: documentEffects.id })
      .from(documentEffects)
      .where(
        and(
          eq(documentEffects.documentType, "INVOICE"),
          eq(documentEffects.documentId, 8888),
        ),
      );
    expect(rows.length).toBe(2);
  });
});

// ═══ ملاحظاتُ Codex #957 — ثلاثة أعطابٍ حقيقية أُغلقت ═══
// (١) `ONLY` بقائمةٍ فارغة كان يفتحُ إلى ALL صامتاً.
// (٢) `cancel` كان يسجّل أثراً وهمياً للمتغيّرات الخدميّة (`movementId=0` لا يمسّ المخزون).
// (٣) `cancel` و`returnService` يشتركان في `(INVOICE, id, INVENTORY)` بسلاسل `scope` مختلفة،
//     فعكسُ الإلغاءِ كان يبتلع أثرَ المرتجع السابق.

describe("محرّك العكس — ملاحظات Codex #957", () => {
  it("ONLY بقائمةٍ فارغةٍ = صفر انتقاء (لا فتحةَ خفيّةَ إلى ALL)", async () => {
    await withTx(async (tx) => {
      await recordEffect(
        tx,
        {
          documentType: "INVOICE",
          documentId: 95701,
          effectKind: "PAID_AMOUNT",
          signedAmount: "500.00",
          branchId: 1,
        },
        ACTOR,
      );
      await recordEffect(
        tx,
        {
          documentType: "INVOICE",
          documentId: 95701,
          effectKind: "LEDGER_ENTRY",
          signedAmount: "500.00",
          branchId: 1,
        },
        ACTOR,
      );
    });
    // قبل الإصلاح: قائمةٌ فارغة تفتحُ إلى ALL وتعكسُ الأثرَين. بعده: صفرٌ حتماً.
    const result = await withTx((tx) =>
      reverse(
        tx,
        "INVOICE",
        95701,
        { kind: "ONLY", effectKinds: [] },
        "قائمةٌ فارغة",
        ACTOR,
      ),
    );
    expect(result.reversedCount).toBe(0);
    // والثابتُ يفشل حين يُطلَب على أثرٍ مالٍ لم يُعكَس — لكن مع صفر انتقاء لا يُنفَّذ فحصاً.
    // نتأكّد أنّ الآثارَ ما زالت قائمةً بلا REVERSE.
    const rows = await db()
      .select({ phase: documentEffects.phase })
      .from(documentEffects)
      .where(
        and(
          eq(documentEffects.documentType, "INVOICE"),
          eq(documentEffects.documentId, 95701),
        ),
      );
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.phase === "APPLY")).toBe(true);
  });

  it("operationScopes يفصل هويّة العكس بين إلغاءٍ ومرتجعٍ سابق على نفس المستند", async () => {
    // مرتجعٌ سابق: يُسجَّل تحت scope='return'
    await withTx(async (tx) => {
      await recordEffect(
        tx,
        {
          documentType: "INVOICE",
          documentId: 95704,
          effectKind: "INVENTORY",
          effectTable: "inventoryMovements",
          effectRowId: 111,
          signedQuantity: 3,
          scope: "return",
          branchId: 1,
        },
        ACTOR,
      );
    });
    // ثمّ إلغاءٌ لاحق: يُسجَّل تحت scope='cancel'
    await withTx(async (tx) => {
      await recordEffect(
        tx,
        {
          documentType: "INVOICE",
          documentId: 95704,
          effectKind: "INVENTORY",
          effectTable: "inventoryMovements",
          effectRowId: 222,
          signedQuantity: 5,
          scope: "cancel",
          branchId: 1,
        },
        ACTOR,
      );
    });

    // عكسُ الإلغاءِ فقط — مقيَّداً بـoperationScopes: يجب ألّا يمسّ أثرَ المرتجع.
    const result = await withTx((tx) =>
      reverse(
        tx,
        "INVOICE",
        95704,
        {
          kind: "ONLY",
          effectKinds: ["INVENTORY"],
          operationScopes: ["cancel"],
        },
        "عكسُ الإلغاء فقط",
        ACTOR,
      ),
    );
    expect(result.reversedCount).toBe(1);

    // أثرُ المرتجع يبقى APPLY بلا REVERSE مقابل — هذا كان يفشل قبل الإصلاح.
    const returnEffects = await db()
      .select({
        id: documentEffects.id,
        phase: documentEffects.phase,
        scope: documentEffects.scope,
      })
      .from(documentEffects)
      .where(
        and(
          eq(documentEffects.documentType, "INVOICE"),
          eq(documentEffects.documentId, 95704),
          eq(documentEffects.scope, "return"),
        ),
      );
    expect(returnEffects.length).toBe(1);
    expect(returnEffects[0].phase).toBe("APPLY");

    // آثارُ الإلغاء = APPLY + REVERSE مقابل.
    const cancelEffects = await db()
      .select({ phase: documentEffects.phase })
      .from(documentEffects)
      .where(
        and(
          eq(documentEffects.documentType, "INVOICE"),
          eq(documentEffects.documentId, 95704),
          eq(documentEffects.scope, "cancel"),
        ),
      );
    expect(cancelEffects.length).toBe(2);
    expect(cancelEffects.filter((r) => r.phase === "APPLY").length).toBe(1);
    expect(cancelEffects.filter((r) => r.phase === "REVERSE").length).toBe(1);

    // الثابتُ على النطاق المُعكوس (scope='cancel') = صفر — يجب أن يمرّ.
    await withTx((tx) =>
      assertReversalBalancedTx(tx, "INVOICE", 95704, {
        kind: "ONLY",
        effectKinds: ["INVENTORY"],
        operationScopes: ["cancel"],
      }),
    );
  });

  it("assertReversalBalancedTx مع ONLY فارغ = عمليّةٌ نائمة (لا كتابةَ ولا خطأ)", async () => {
    // بلا آثار — مجرّد تأكيد أنّ النطاق الفارغ لا يُنشئ استعلامَ فحصٍ خاطئ.
    await withTx((tx) =>
      assertReversalBalancedTx(tx, "INVOICE", 95703, {
        kind: "ONLY",
        effectKinds: [],
      }),
    );
  });
});
