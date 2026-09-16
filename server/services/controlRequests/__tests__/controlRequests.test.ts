/**
 * ═══ اختبارات طلبات الحوكمة الموحّدة (م٧، هجرة 0331) ═══
 *
 * الثوابتُ المحروسة في هذه المجموعة (٩ اختبارات):
 *
 *  ① فتحُ طلبٍ ناجح ⇒ يعود PENDING بمعرّفٍ موجب.
 *  ② بلا سبب ⇒ BAD_REQUEST (بلا صفٍّ في الجدول).
 *  ③ طلبٌ ثانٍ نشطٌ على نفس القرار/الكيان ⇒ CONFLICT.
 *  ④ `decisionKey` غير مُسجَّل في السجلّ ⇒ BAD_REQUEST.
 *  ⑤ SOD: المُنشئ لا يقرّر ⇒ FORBIDDEN.
 *  ⑥ حسمُ طلبٍ محسوم ⇒ CONFLICT (بلا تغيّرٍ في الصفّ).
 *  ⑦ السحبُ من المُنشئ ⇒ ينجح ويعود WITHDRAWN.
 *  ⑧ السحبُ من غير المُنشئ ⇒ FORBIDDEN.
 *  ⑨ readActiveControlRequestFor يعيد الطلبَ النشط الوحيد؛ ⇒ null بعد الحسم أو السحب،
 *     وبعد الحسم يقبل الجدولُ طلباً جديداً على نفس القرار/الكيان (UNIQUE على generated
 *     يعود NULL).
 *
 * الاختبار **بلا FK على `users`** لأنّ الجدول لا يحملها (polymorphic بحكم التصميم).
 * فلا نحتاج بذرَ مستخدمين — نستعمل معرّفاتٍ صناعيّة.
 */
import { asc, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { controlRequests } from "../../../../drizzle/schema";
import { getDb } from "../../../db";
import {
  decideControlRequest,
  openControlRequest,
  readActiveControlRequestFor,
  withdrawControlRequest,
} from "../index";
import { withTx, type Actor } from "../../tx";

/** قرارٌ حقيقيٌّ مُسجَّلٌ في `shared/decisionRegistry.ts` — يمرّ فحص `decisionSpec`. */
const REAL_DECISION_KEY = "purchase.order.control";

const REQUESTER: Actor = {
  userId: 1001,
  branchId: 1,
  role: "purchase_officer",
};
const APPROVER: Actor = {
  userId: 1002,
  branchId: 1,
  role: "manager",
};

function db() {
  const database = getDb();
  if (!database) throw new Error("DATABASE_URL not set for tests");
  return database;
}

beforeEach(async () => {
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  await db().execute(sql`TRUNCATE TABLE controlRequests`);
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
});

describe("openControlRequest — فتحُ الطلب", () => {
  it("① فتحٌ ناجح ⇒ PENDING بمعرّفٍ موجبٍ وسببٍ محفوظ", async () => {
    const res = await withTx((tx) =>
      openControlRequest(
        tx,
        {
          decisionKey: REAL_DECISION_KEY,
          entityType: "purchaseOrder",
          entityId: 501,
          reason: "المبلغ يتجاوز حدّ صلاحيتي",
          payloadJson: { total: "1500.00", supplier: "مورّد الشمال" },
        },
        REQUESTER,
      ),
    );
    expect(res.id).toBeGreaterThan(0);

    const rows = await db()
      .select()
      .from(controlRequests)
      .orderBy(asc(controlRequests.id));
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("PENDING");
    expect(rows[0].decisionKey).toBe(REAL_DECISION_KEY);
    expect(rows[0].entityType).toBe("purchaseOrder");
    expect(rows[0].entityId).toBe(501);
    expect(rows[0].requestedByUserId).toBe(REQUESTER.userId);
    expect(rows[0].reason).toBe("المبلغ يتجاوز حدّ صلاحيتي");
    expect(rows[0].decidedByUserId).toBeNull();
    expect(rows[0].decidedAt).toBeNull();
  });

  it("② بلا سبب ⇒ BAD_REQUEST (بلا صفٍّ في الجدول)", async () => {
    await expect(
      withTx((tx) =>
        openControlRequest(
          tx,
          {
            decisionKey: REAL_DECISION_KEY,
            entityType: "purchaseOrder",
            entityId: 502,
            reason: "   \n\t  ",
          },
          REQUESTER,
        ),
      ),
    ).rejects.toThrow(/سبب/);

    const rows = await db().select().from(controlRequests);
    expect(rows.length).toBe(0);
  });

  it("③ طلبٌ ثانٍ نشطٌ على نفس القرار/الكيان ⇒ CONFLICT", async () => {
    await withTx((tx) =>
      openControlRequest(
        tx,
        {
          decisionKey: REAL_DECISION_KEY,
          entityType: "purchaseOrder",
          entityId: 503,
          reason: "طلبٌ أوّل",
        },
        REQUESTER,
      ),
    );

    await expect(
      withTx((tx) =>
        openControlRequest(
          tx,
          {
            decisionKey: REAL_DECISION_KEY,
            entityType: "purchaseOrder",
            entityId: 503,
            reason: "محاولةٌ ثانية",
          },
          REQUESTER,
        ),
      ),
    ).rejects.toThrow(/نشط/);

    // صفٌّ واحدٌ فقط — الفشلُ مغلقٌ داخل المعاملة.
    const rows = await db().select().from(controlRequests);
    expect(rows.length).toBe(1);
  });

  it("④ decisionKey غير مُسجَّل ⇒ BAD_REQUEST يوجّه لتسجيله", async () => {
    await expect(
      withTx((tx) =>
        openControlRequest(
          tx,
          {
            decisionKey: "made.up.key",
            entityType: "purchaseOrder",
            entityId: 504,
            reason: "لن يمرّ",
          },
          REQUESTER,
        ),
      ),
    ).rejects.toThrow(/سجلّ القرارات|decisionRegistry/);

    const rows = await db().select().from(controlRequests);
    expect(rows.length).toBe(0);
  });
});

describe("decideControlRequest — فصلُ المهام والحسمُ الذرّي", () => {
  it("⑤ SOD: المُنشئُ لا يقرّر طلبَه ⇒ FORBIDDEN", async () => {
    const { id } = await withTx((tx) =>
      openControlRequest(
        tx,
        {
          decisionKey: REAL_DECISION_KEY,
          entityType: "purchaseOrder",
          entityId: 505,
          reason: "أوّل طلب",
        },
        REQUESTER,
      ),
    );

    await expect(
      withTx((tx) =>
        decideControlRequest(
          tx,
          id,
          { decision: "APPROVED" },
          REQUESTER, // نفس مُنشئ الطلب
        ),
      ),
    ).rejects.toThrow(/فصل المهام|SOD|المُنشئ/);

    // الطلبُ لم يتغيّر — أثرُ الرفض مغلق.
    const rows = await db().select().from(controlRequests);
    expect(rows[0].status).toBe("PENDING");
    expect(rows[0].decidedByUserId).toBeNull();
  });

  it("⑥ حسمُ طلبٍ محسوم ⇒ CONFLICT (بلا تغيّرٍ في الصفّ)", async () => {
    const { id } = await withTx((tx) =>
      openControlRequest(
        tx,
        {
          decisionKey: REAL_DECISION_KEY,
          entityType: "purchaseOrder",
          entityId: 506,
          reason: "طلبٌ للاعتماد",
        },
        REQUESTER,
      ),
    );

    // اعتمادٌ ناجحٌ أوّل
    const approved = await withTx((tx) =>
      decideControlRequest(
        tx,
        id,
        { decision: "APPROVED", decisionNote: "تمّ التحقّق من الأرصدة" },
        APPROVER,
      ),
    );
    expect(approved.status).toBe("APPROVED");
    expect(approved.decidedByUserId).toBe(APPROVER.userId);
    expect(approved.decisionNote).toBe("تمّ التحقّق من الأرصدة");

    // محاولةٌ ثانيةٌ ترفض
    await expect(
      withTx((tx) =>
        decideControlRequest(
          tx,
          id,
          { decision: "REJECTED", decisionNote: "تراجعت" },
          APPROVER,
        ),
      ),
    ).rejects.toThrow(/محسوم/);

    // الطلبُ بقي APPROVED — الحسمُ الأوّل هو الوحيد.
    const [row] = await db().select().from(controlRequests);
    expect(row.status).toBe("APPROVED");
    expect(row.decisionNote).toBe("تمّ التحقّق من الأرصدة");
  });

  it("رفضٌ بلا ملاحظة ⇒ BAD_REQUEST", async () => {
    const { id } = await withTx((tx) =>
      openControlRequest(
        tx,
        {
          decisionKey: REAL_DECISION_KEY,
          entityType: "purchaseOrder",
          entityId: 507,
          reason: "طلبٌ للرفض",
        },
        REQUESTER,
      ),
    );

    await expect(
      withTx((tx) =>
        decideControlRequest(tx, id, { decision: "REJECTED" }, APPROVER),
      ),
    ).rejects.toThrow(/ملاحظة/);

    const [row] = await db().select().from(controlRequests);
    expect(row.status).toBe("PENDING");
  });
});

describe("withdrawControlRequest — سحبُ المُنشئ", () => {
  it("⑦ السحبُ من المُنشئ ⇒ WITHDRAWN و`decidedByUserId` يبقى NULL", async () => {
    const { id } = await withTx((tx) =>
      openControlRequest(
        tx,
        {
          decisionKey: REAL_DECISION_KEY,
          entityType: "purchaseOrder",
          entityId: 508,
          reason: "سأتراجع",
        },
        REQUESTER,
      ),
    );

    const withdrawn = await withTx((tx) =>
      withdrawControlRequest(tx, id, REQUESTER),
    );
    expect(withdrawn.status).toBe("WITHDRAWN");
    expect(withdrawn.decidedByUserId).toBeNull();
    expect(withdrawn.decidedAt).not.toBeNull();
  });

  it("⑧ السحبُ من غير المُنشئ ⇒ FORBIDDEN", async () => {
    const { id } = await withTx((tx) =>
      openControlRequest(
        tx,
        {
          decisionKey: REAL_DECISION_KEY,
          entityType: "purchaseOrder",
          entityId: 509,
          reason: "طلبٌ لا يُسحب من غيري",
        },
        REQUESTER,
      ),
    );

    await expect(
      withTx((tx) => withdrawControlRequest(tx, id, APPROVER)),
    ).rejects.toThrow(/المُنشئ|السحب/);

    const [row] = await db().select().from(controlRequests);
    expect(row.status).toBe("PENDING");
  });
});

describe("readActiveControlRequestFor — قراءةُ الطلب النشط", () => {
  it("⑨ يعيد الطلبَ النشط الوحيد؛ بعد الحسم يقبل الجدولُ طلباً جديداً", async () => {
    // بلا طلبٍ ⇒ null.
    let active = await withTx((tx) =>
      readActiveControlRequestFor(
        tx,
        REAL_DECISION_KEY,
        "purchaseOrder",
        510,
      ),
    );
    expect(active).toBeNull();

    // فتحُ طلبٍ ⇒ يعود من القراءة.
    const { id: id1 } = await withTx((tx) =>
      openControlRequest(
        tx,
        {
          decisionKey: REAL_DECISION_KEY,
          entityType: "purchaseOrder",
          entityId: 510,
          reason: "الطلب الأوّل",
        },
        REQUESTER,
      ),
    );
    active = await withTx((tx) =>
      readActiveControlRequestFor(
        tx,
        REAL_DECISION_KEY,
        "purchaseOrder",
        510,
      ),
    );
    expect(active?.id).toBe(id1);

    // حسمُه ⇒ activeSlot يعود NULL ⇒ قراءة النشط null.
    await withTx((tx) =>
      decideControlRequest(
        tx,
        id1,
        { decision: "REJECTED", decisionNote: "أُرفض" },
        APPROVER,
      ),
    );
    active = await withTx((tx) =>
      readActiveControlRequestFor(
        tx,
        REAL_DECISION_KEY,
        "purchaseOrder",
        510,
      ),
    );
    expect(active).toBeNull();

    // طلبٌ جديدٌ على نفس القرار/الكيان يمرّ لأنّ UNIQUE(activeSlot) يعود NULL
    // على الطلب المحسوم — هذا هو غرض العمود المولَّد.
    const { id: id2 } = await withTx((tx) =>
      openControlRequest(
        tx,
        {
          decisionKey: REAL_DECISION_KEY,
          entityType: "purchaseOrder",
          entityId: 510,
          reason: "بعد الرفض أعيد المحاولة بأدلّة",
        },
        REQUESTER,
      ),
    );
    expect(id2).toBeGreaterThan(id1);
    active = await withTx((tx) =>
      readActiveControlRequestFor(
        tx,
        REAL_DECISION_KEY,
        "purchaseOrder",
        510,
      ),
    );
    expect(active?.id).toBe(id2);
  });
});
