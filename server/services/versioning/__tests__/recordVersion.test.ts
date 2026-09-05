/**
 * ═══ اختبارات اللقطة والاستعادة (م٦ ق٨، هجرة 0330) ═══
 *
 * الثابت المحروس: `snapshotBeforeUpdate` تفشل مغلقةً بلا سبب أو خارج معاملة. الاستعادةُ
 * تعديلٌ جديدٌ عبر callback يمرّ بحرّاس المستدعي — لا كتابةٌ خامٌّ للجدول الأصل.
 *
 * تغطيةٌ منفصلة لعقد الخدمة نفسه؛ التوصيلُ في `updateCustomer` مغطًّى في
 * `customerVersioning.test.ts` — كي لا نخلط عيّنات الاختبار (الخدمة تعمل مع أيّ نوع
 * كيان، فلا يجوز اختبارها مع صفوف عملاء حقيقية وحدها).
 */
import { asc, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { recordVersions } from "../../../../drizzle/schema";
import { getDb } from "../../../db";
import {
  readVersion,
  readVersionHistory,
  restoreToVersion,
  snapshotBeforeUpdate,
} from "../recordVersion";
import { withTx, type Actor } from "../../tx";

const ACTOR: Actor = { userId: 1, branchId: 1, role: "admin", isOwner: true };

function db() {
  const database = getDb();
  if (!database) throw new Error("DATABASE_URL not set for tests");
  return database;
}

beforeEach(async () => {
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  await db().execute(sql`TRUNCATE TABLE recordVersions`);
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
});

describe("snapshotBeforeUpdate — الحالات الحاكمة", () => {
  it("تُنشئ لقطةً بأول versionNumber = 1 وتصعد لاحقاً", async () => {
    const res1 = await withTx((tx) =>
      snapshotBeforeUpdate(
        tx,
        {
          entityType: "widget",
          entityId: 42,
          payloadJson: { name: "قبل التعديل الأول", cost: "1000.00" },
          reason: "أول تعديل",
        },
        ACTOR,
      ),
    );
    expect(res1.versionNumber).toBe(1);
    expect(res1.id).toBeGreaterThan(0);

    const res2 = await withTx((tx) =>
      snapshotBeforeUpdate(
        tx,
        {
          entityType: "widget",
          entityId: 42,
          payloadJson: { name: "قبل التعديل الثاني", cost: "1250.00" },
          reason: "ثاني تعديل",
        },
        ACTOR,
      ),
    );
    expect(res2.versionNumber).toBe(2);
    expect(res2.id).toBeGreaterThan(res1.id);

    // كيانٌ مختلف بنفس النوع = خطُّ إصداراتٍ مستقلّ
    const otherEntity = await withTx((tx) =>
      snapshotBeforeUpdate(
        tx,
        {
          entityType: "widget",
          entityId: 99,
          payloadJson: { name: "كيان آخر" },
          reason: "أول تعديل لكيان آخر",
        },
        ACTOR,
      ),
    );
    expect(otherEntity.versionNumber).toBe(1);
  });

  it("ترمي BAD_REQUEST حين يكون السبب فارغاً أو مسافات بيضاء", async () => {
    await expect(
      withTx((tx) =>
        snapshotBeforeUpdate(
          tx,
          { entityType: "widget", entityId: 1, payloadJson: {}, reason: "" },
          ACTOR,
        ),
      ),
    ).rejects.toThrow(/سبب/);

    await expect(
      withTx((tx) =>
        snapshotBeforeUpdate(
          tx,
          { entityType: "widget", entityId: 1, payloadJson: {}, reason: "   \n\t  " },
          ACTOR,
        ),
      ),
    ).rejects.toThrow(/سبب/);

    // لا صفَّ محفوظاً بعد الرمي — الفشلُ مغلقٌ داخل المعاملة.
    const rows = await db().select().from(recordVersions);
    expect(rows.length).toBe(0);
  });

  it("ترمي BAD_REQUEST حين يتجاوز السبب 500 محرف — الاقتطاعُ ممنوع", async () => {
    const longReason = "أ".repeat(501);
    await expect(
      withTx((tx) =>
        snapshotBeforeUpdate(
          tx,
          { entityType: "widget", entityId: 1, payloadJson: {}, reason: longReason },
          ACTOR,
        ),
      ),
    ).rejects.toThrow(/501|500/);
  });

  it("ترمي INTERNAL_SERVER_ERROR حين تُستدعى خارج معاملة (بمعامل قاعدة)", async () => {
    // نمرّر DB مباشرةً (لا Tx). التصنيفُ في TypeScript يرفض هذا، لكنّ الفحصَ في وقت
    // التشغيل دفاعٌ متعمّق ضدّ مستدعٍ غير مُنمَّط (استيرادٌ ديناميكيّ/js).
    await expect(
      snapshotBeforeUpdate(
        db() as unknown as Parameters<typeof snapshotBeforeUpdate>[0],
        { entityType: "widget", entityId: 1, payloadJson: {}, reason: "خارج معاملة" },
        ACTOR,
      ),
    ).rejects.toThrow(/معاملة|withTx/);
  });

  it("readVersionHistory تعيد الإصدارات تصاعدياً (1..N)", async () => {
    for (let i = 1; i <= 4; i++) {
      await withTx((tx) =>
        snapshotBeforeUpdate(
          tx,
          {
            entityType: "widget",
            entityId: 7,
            payloadJson: { revision: i },
            reason: `تعديل رقم ${i}`,
          },
          ACTOR,
        ),
      );
    }
    const history = await withTx((tx) => readVersionHistory(tx, "widget", 7));
    expect(history.length).toBe(4);
    expect(history.map((v) => v.versionNumber)).toEqual([1, 2, 3, 4]);
    expect(history.map((v) => (v.payloadJson as { revision: number }).revision)).toEqual([1, 2, 3, 4]);
  });

  it("restoreToVersion يستحضر حمولةً قديمةً ويستدعي applyRestore", async () => {
    await withTx((tx) =>
      snapshotBeforeUpdate(
        tx,
        {
          entityType: "widget",
          entityId: 55,
          payloadJson: { name: "الحالة القديمة", version: "old" },
          reason: "لقطة أولى",
        },
        ACTOR,
      ),
    );

    let receivedPayload: unknown = null;
    let receivedReason: string = "";
    const applyRestore = async (
      _tx: Parameters<typeof snapshotBeforeUpdate>[0],
      payload: unknown,
      _actor: Parameters<typeof snapshotBeforeUpdate>[2],
      restoreReason: string,
    ) => {
      receivedPayload = payload;
      receivedReason = restoreReason;
      return { updated: true };
    };

    const res = await withTx((tx) =>
      restoreToVersion(
        tx,
        {
          entityType: "widget",
          entityId: 55,
          versionNumber: 1,
          applyRestore,
        },
        ACTOR,
      ),
    );

    expect(res.restoredFromVersion).toBe(1);
    expect(receivedPayload).toEqual({ name: "الحالة القديمة", version: "old" });
    expect(receivedReason).toBe("استعادة إلى الإصدار 1");
  });

  it("restoreToVersion على إصدارٍ غير موجود يرمي NOT_FOUND", async () => {
    await expect(
      withTx((tx) =>
        restoreToVersion(
          tx,
          {
            entityType: "widget",
            entityId: 88,
            versionNumber: 3,
            applyRestore: async () => ({ updated: true }),
          },
          ACTOR,
        ),
      ),
    ).rejects.toThrow(/الإصدار|غير موجود/);
  });

  it("Codex #963: restoreToVersion يرفض applyRestore الذي يُبلّغ updated=false", async () => {
    await withTx((tx) =>
      snapshotBeforeUpdate(
        tx,
        { entityType: "widget", entityId: 77, payloadJson: { v: 1 }, reason: "lقطة" },
        ACTOR,
      ),
    );
    await expect(
      withTx((tx) =>
        restoreToVersion(
          tx,
          {
            entityType: "widget",
            entityId: 77,
            versionNumber: 1,
            applyRestore: async () => ({ updated: false }),
          },
          ACTOR,
        ),
      ),
    ).rejects.toThrow(/تعذّرت الاستعادة/);
  });

  it("Codex #963: تسجيل لقطة يرفض حمولةً فيها undefined صريح", async () => {
    await expect(
      withTx((tx) =>
        snapshotBeforeUpdate(
          tx,
          {
            entityType: "widget",
            entityId: 99,
            payloadJson: { name: "x", ghost: undefined as unknown as string },
            reason: "اختبار",
          },
          ACTOR,
        ),
      ),
    ).rejects.toThrow(/يحذفه من اللقطة|undefined/);
  });

  it("Codex #963: تسجيل لقطة يرفض NaN/Infinity كأعداد", async () => {
    await expect(
      withTx((tx) =>
        snapshotBeforeUpdate(
          tx,
          { entityType: "widget", entityId: 91, payloadJson: { qty: NaN }, reason: "اختبار" },
          ACTOR,
        ),
      ),
    ).rejects.toThrow(/غير منتهية/);
  });

  it("readVersion يرمي NOT_FOUND عند طلب إصدارٍ خارج النطاق", async () => {
    await withTx((tx) =>
      snapshotBeforeUpdate(
        tx,
        {
          entityType: "widget",
          entityId: 33,
          payloadJson: { revision: 1 },
          reason: "أول لقطة",
        },
        ACTOR,
      ),
    );
    await expect(
      withTx((tx) => readVersion(tx, "widget", 33, 2)),
    ).rejects.toThrow(/الإصدار|غير موجود/);
  });

  it("LCD: Dates و Decimal تنجو round-trip عبر JSON دون كسر", async () => {
    const now = new Date("2026-09-03T12:34:56.000Z");
    const payload = {
      createdAt: now,
      cost: "1450.99", // نمثّل Decimal.js.toJSON() كسلسلة
      nested: { list: [1, 2, 3], flag: true, empty: null },
    };
    const res = await withTx((tx) =>
      snapshotBeforeUpdate(
        tx,
        { entityType: "widget", entityId: 1, payloadJson: payload, reason: "اختبار round-trip" },
        ACTOR,
      ),
    );
    const [row] = await db()
      .select()
      .from(recordVersions)
      .where(eq(recordVersions.id, res.id));
    const stored = row.payloadJson as Record<string, unknown>;
    // Date.toJSON() ⇒ ISO 8601
    expect(stored.createdAt).toBe(now.toISOString());
    expect(stored.cost).toBe("1450.99");
    expect(stored.nested).toEqual({ list: [1, 2, 3], flag: true, empty: null });
  });

  it("رقمُ الإصدار يُميّز entityType/entityId ⇒ خطوطٌ متوازية مستقلّة", async () => {
    await withTx((tx) =>
      snapshotBeforeUpdate(
        tx,
        { entityType: "product", entityId: 1, payloadJson: {}, reason: "أ" },
        ACTOR,
      ),
    );
    await withTx((tx) =>
      snapshotBeforeUpdate(
        tx,
        { entityType: "customer", entityId: 1, payloadJson: {}, reason: "ب" },
        ACTOR,
      ),
    );
    // نفس entityId لكنّ النوع مختلف = خطُّ إصداراتٍ مستقلّ.
    const rows = await db()
      .select()
      .from(recordVersions)
      .orderBy(asc(recordVersions.id));
    expect(rows.length).toBe(2);
    expect(rows[0].versionNumber).toBe(1);
    expect(rows[1].versionNumber).toBe(1);
  });
});
