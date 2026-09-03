/**
 * ═══ خدمةُ طلبات الحوكمة الموحّدة (م٧، هجرة 0331) ═══
 *
 * **العلّةُ المقيسة (D3 في `scripts/check-friction.mjs`، خطّ أساس ٧٥ موضعاً):** المستودعُ
 * يحمل ٣٠ جدولَ «طلب اعتماد» متشظّياً في ٣٥ راوتراً؛ لا مفردةَ واحدة تجمعها. نتيجةً،
 * طوابيرُ الاعتماد مخفيّة، وكلُّ راوترٍ يعيد اختراعَ فصل المهام على طريقته (ثمّ ينساه
 * أحياناً). هذه الخدمةُ نصفٌ حاكمٌ من العلاج: مُدخلٌ وحيدٌ لبناء طلبٍ حوكميّ وحسمه.
 *
 * **الثوابتُ المحروسة بنيوياً (SQL) + خدميّاً:**
 *
 *  ① **طلبٌ نشطٌ واحدٌ لكلّ (قرار، كيان):** فرضٌ بنيويٌّ عبر UNIQUE على العمود المولَّد
 *     `activeSlot`. سباقٌ نادرٌ يُلقي `ER_DUP_ENTRY` من MySQL — نلتقطه ونحوّله لرسالةٍ
 *     مفهومة. طلبٌ ثانٍ **بعد** قرارٍ نافذٌ لأنّ العمود يعود NULL بعد الحسم.
 *
 *  ② **فصلُ المهام (SOD) بنيويّاً:** CHECK يفرض `decidedByUserId <> requestedByUserId`
 *     على الحسم. الخدمةُ ترميه صراحةً برسالةٍ عربية قبل بلوغ SQL.
 *
 *  ③ **طلبٌ محسومٌ لا يُعاد فتحه:** `UPDATE ... WHERE status = 'PENDING'` في `decide`
 *     و`withdraw`، والفحصُ لعدد الصفوف المتأثّرة — سباقٌ يخسر يعود بـ`CONFLICT`.
 *
 *  ④ **بلا سببٍ ⇒ لا طلب:** رميٌ صريح من `openControlRequest` قبل SQL (السببُ يظهر
 *     في صندوق القرار، ومن ثمّ للطالب حين يُرفض).
 *
 *  ⑤ **`decisionKey` مُسجَّلٌ في `shared/decisionRegistry.ts`:** فحصٌ صريح، وإلّا ننشئ
 *     طلباتٍ على قراراتٍ غير موصوفة — يُبطل الغرضَ الأصليّ من السجلّ.
 *
 * ⛔ **حدودُ هذه الشريحة:** لا راوتر ولا UI. التوصيلُ في موجاتٍ لاحقة — عندها تحلّ محلّ
 * الجداول المتشظّية تدريجياً بلا كسرها. المسندُ الوحيد على واجهةٍ اليوم هو ما تكتبه
 * راوتراتٌ أُخرى داخل معاملاتها الحالية.
 *
 * ⛔ **الخدمة لا تقرأ `ctx`** — تستقبل `Actor` صريحاً (§٥ من `CLAUDE.md`).
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, sql } from "drizzle-orm";

import {
  controlRequests,
  type ControlRequest,
  type InsertControlRequest,
} from "../../../drizzle/schema";
import { appErrorMessage } from "@shared/errors";
import { decisionSpec } from "@shared/decisionRegistry";
import type { Tx } from "../../db";
import { extractAffectedRows, extractInsertId } from "../../lib/insertId";
import type { Actor } from "../tx";

/** حدُّ طول السبب — يطابق طول العمود في المخطّط. */
const REASON_MAX = 1000;
/** حدُّ طول ملاحظة القرار — يطابق طول العمود في المخطّط. */
const DECISION_NOTE_MAX = 1000;

/** حالاتُ الطلب — كما هي في الـenum على العمود. */
export type ControlRequestStatus =
  | "PENDING"
  | "APPROVED"
  | "REJECTED"
  | "WITHDRAWN"
  | "SUPERSEDED";

/** قرارُ المُقرِّر على طلبٍ نشط. */
export type ControlRequestDecision = "APPROVED" | "REJECTED";

/** حمولةُ فتح طلبٍ جديد. */
export interface OpenControlRequestInput {
  /** مفتاحُ القرار من `DECISION_REGISTRY` — يُرفَض إن لم يكن مُسجَّلاً. */
  decisionKey: string;
  /** نوعُ الكيان (`purchaseOrder`, `invoice`, `stocktakeSession`, …). */
  entityType: string;
  /** معرّفُ الكيان — عددٌ صحيحٌ موجب. */
  entityId: number;
  /** سببُ الطلب. **إلزاميّ**، بلا مسافاتٍ محضة. */
  reason: string;
  /** حمولةُ سياقٍ اختيارية (مبلغ، طرف، تفاصيل يعرضها المُقرِّر). */
  payloadJson?: unknown;
  /** سياقُ الفرع — اختياريّ (النظامُ متعدّد الفروع). */
  branchId?: number | null;
}

/** حمولةُ حسم طلبٍ نشط. */
export interface DecideControlRequestInput {
  decision: ControlRequestDecision;
  /** ملاحظةُ القرار. **إلزاميّة** على `REJECTED`؛ اختيارية على `APPROVED`. */
  decisionNote?: string;
}

/**
 * فحصُ أنّ `tx` معاملةٌ فعلاً لا اتصالٌ خامّ. `Tx` في drizzle-mysql2 صنفٌ يحوي
 * `rollback()`؛ الاتصالُ الخامّ (`DB`) لا يحويها. نفس نمط `recordVersion.ts` — دفاعٌ
 * متعمّق ضدّ مستدعٍ غير مُنمَّط (`.js`/استيراد ديناميكيّ).
 */
function assertIsTransaction(tx: unknown): asserts tx is Tx {
  if (
    tx == null ||
    typeof tx !== "object" ||
    typeof (tx as { rollback?: unknown }).rollback !== "function"
  ) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: appErrorMessage({
        what: "تعذّر تسجيل طلب حوكمة",
        why: "الاستدعاء وقع خارج معاملة قاعدة البيانات",
        doThis:
          "استعمل الخدمة داخل `withTx(async (tx) => …)` وسلّم `tx` نفسه",
      }),
    });
  }
}

/** يفحص أنّ `Actor` مكتمل — بلا `userId` يُبطل SOD كلياً. */
function assertActor(actor: Actor): void {
  if (!actor || !Number.isInteger(actor.userId) || actor.userId <= 0) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: appErrorMessage({
        what: "تعذّر تسجيل طلب حوكمة",
        why: "الفاعلُ (Actor) غير محدَّد أو بلا `userId` صالح",
        doThis:
          "مرّر `Actor { userId, branchId, role }` من الراوتر عبر `server/trpc.ts`",
      }),
    });
  }
}

/**
 * يفتح طلبَ حوكمةٍ جديداً في حالة `PENDING`. يفشل مغلقاً بلا سبب، أو حين لا يكون
 * `decisionKey` مُسجَّلاً في `decisionRegistry`، أو حين يوجد طلبٌ نشطٌ آخر على نفس
 * القرار والكيان (فحصٌ مسبقٌ برسالةٍ واضحة، مع فخّ `ER_DUP_ENTRY` كدفاعٍ متعمّق ضدّ
 * السباق).
 */
export async function openControlRequest(
  tx: Tx,
  input: OpenControlRequestInput,
  actor: Actor,
): Promise<{ id: number }> {
  assertIsTransaction(tx);
  assertActor(actor);

  const decisionKey = String(input.decisionKey ?? "").trim();
  if (!decisionKey) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر فتح طلب حوكمة",
        why: "مفتاحُ القرار `decisionKey` فارغ",
        doThis:
          "سلّم مفتاحاً مُسجَّلاً في `shared/decisionRegistry.ts` (مثل `purchases.approve`)",
      }),
    });
  }

  // فحصُ التسجيل — قرارٌ غير موصوفٍ في السجلّ = صندوقُ اعتمادٍ يعرض ما لا وجودَ له.
  if (!decisionSpec(decisionKey)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر فتح طلب حوكمة",
        why: `المفتاح \`${decisionKey}\` غير مُسجَّل في سجلّ القرارات`,
        doThis:
          "سجّل القرار في `shared/decisionRegistry.ts` أوّلاً (مع دليل الإجراء الخادميّ الذي ينفّذه)",
      }),
    });
  }

  const entityType = String(input.entityType ?? "").trim();
  if (!entityType) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر فتح طلب حوكمة",
        why: "نوعُ الكيان `entityType` فارغ",
        doThis:
          "سلّم نوعاً غير فارغ (مثل `purchaseOrder` أو `invoice` أو `stocktakeSession`)",
      }),
    });
  }

  if (!Number.isInteger(input.entityId) || input.entityId <= 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر فتح طلب حوكمة",
        why: `معرّفُ الكيان \`entityId\` ليس عدداً صحيحاً موجباً (${String(input.entityId)})`,
        doThis: "مرّر مُعرّفَ صفٍّ قائمٍ من جدول الكيان",
      }),
    });
  }

  const reason = String(input.reason ?? "").trim();
  if (!reason) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر فتح طلب حوكمة",
        why: "سببُ الطلب مطلوب — يظهر للمُقرِّر ثمّ للطالب إن رُفض",
        doThis: "اكتب سبباً موجزاً (لماذا تطلب هذا الاعتماد الآن)",
      }),
    });
  }
  if (reason.length > REASON_MAX) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر فتح طلب حوكمة",
        why: `طولُ السبب ${reason.length} محرف — الحدّ الأقصى ${REASON_MAX} محرف`,
        doThis:
          "اختصر السبب أو انقل التفاصيل إلى حمولةٍ منفصلة في `payloadJson`",
      }),
    });
  }

  // فحصٌ مسبقٌ: هل يوجد طلبٌ نشطٌ؟ رسالةٌ واضحة بدل ER_DUP_ENTRY عربيّ خامّ.
  const existing = await readActiveControlRequestFor(
    tx,
    decisionKey,
    entityType,
    input.entityId,
  );
  if (existing) {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذّر فتح طلب حوكمة",
        why: `يوجد طلبٌ نشطٌ آخر (رقم ${existing.id}) على نفس القرار والكيان`,
        doThis:
          "انتظر قرارَ الطلب النشط، أو اسحبه (WITHDRAWN) إن كنت مُنشئه، ثم أعد المحاولة",
      }),
    });
  }

  const row: InsertControlRequest = {
    decisionKey,
    entityType,
    entityId: input.entityId,
    status: "PENDING",
    requestedByUserId: actor.userId,
    reason,
    // Drizzle's `json()` handles serialization; `null` is stored as SQL NULL.
    payloadJson: (input.payloadJson ?? null) as InsertControlRequest["payloadJson"],
    branchId: input.branchId ?? actor.branchId ?? null,
  };

  try {
    const result = await tx.insert(controlRequests).values(row);
    const id = extractInsertId(result);
    return { id };
  } catch (err) {
    // دفاعٌ متعمّق ضدّ السباق: قد يخسر ER_DUP_ENTRY حتى بعد الفحص المسبق حين
    // معاملتان تفتحان معاً على نفس القرار والكيان.
    const code = (err as { code?: string } | null)?.code;
    if (code === "ER_DUP_ENTRY") {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر فتح طلب حوكمة",
          why: "طلبٌ آخر على نفس القرار والكيان فُتح للتوّ من جلسةٍ أخرى",
          doThis:
            "أعد تحميل الطلبات النشطة على هذا الكيان قبل المحاولة مرّة أخرى",
        }),
      });
    }
    throw err;
  }
}

/**
 * يحسم طلباً نشطاً (APPROVED/REJECTED). يفرض فصلَ المهام (المُقرِّر ليس المُنشئ)،
 * ويرفض طلباً محسوماً بالفعل عبر `WHERE status = 'PENDING'` وفحص عدد الصفوف
 * المتأثّرة. الرفضُ يلزمه ملاحظةٌ نصّية (يحرسه CHECK؛ نرفضها هنا بعقد قابل للقراءة).
 */
export async function decideControlRequest(
  tx: Tx,
  requestId: number,
  input: DecideControlRequestInput,
  actor: Actor,
): Promise<ControlRequest> {
  assertIsTransaction(tx);
  assertActor(actor);

  if (!Number.isInteger(requestId) || requestId <= 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر حسم طلب الحوكمة",
        why: `معرّفُ الطلب ليس عدداً صحيحاً موجباً (${String(requestId)})`,
        doThis: "مرّر مُعرّفَ طلبٍ قائم",
      }),
    });
  }

  const decision = input.decision;
  if (decision !== "APPROVED" && decision !== "REJECTED") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر حسم طلب الحوكمة",
        why: `قرارٌ غير معروف (${String(decision)}) — المسموح: APPROVED, REJECTED`,
        doThis: "استعمل `APPROVED` أو `REJECTED`",
      }),
    });
  }

  const decisionNote = String(input.decisionNote ?? "").trim();
  if (decision === "REJECTED" && !decisionNote) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر رفض طلب الحوكمة",
        why: "ملاحظةُ القرار مطلوبة على الرفض — الطالبُ يحتاج أن يعرف لماذا رُفض ليصحّح",
        doThis: "اكتب ملاحظةً موجزةً تشرح سبب الرفض",
      }),
    });
  }
  if (decisionNote && decisionNote.length > DECISION_NOTE_MAX) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر حسم طلب الحوكمة",
        why: `طولُ الملاحظة ${decisionNote.length} محرف — الحدّ الأقصى ${DECISION_NOTE_MAX} محرف`,
        doThis: "اختصر الملاحظة",
      }),
    });
  }

  // قراءةُ الطلب أوّلاً — نحتاج مُنشئه لفصل المهام. SELECT ... FOR UPDATE يقفل الصفّ
  // فلا يُحسم من جلسةٍ أخرى بعد قراءتنا وقبل كتابتنا.
  const [existing] = await tx
    .select()
    .from(controlRequests)
    .where(eq(controlRequests.id, requestId))
    .for("update")
    .limit(1);

  if (!existing) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: appErrorMessage({
        what: "تعذّر حسم طلب الحوكمة",
        why: `الطلبُ رقم ${requestId} غير موجود`,
        doThis: "تحقّق من المعرّف أو أعد تحميل قائمة الطلبات النشطة",
      }),
    });
  }

  if (existing.status !== "PENDING") {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذّر حسم طلب الحوكمة",
        why: `الطلبُ رقم ${requestId} محسومٌ بالفعل (حالته ${existing.status})`,
        doThis: "لا يُعاد فتح الطلبات المحسومة — افتح طلباً جديداً إن لزم",
      }),
    });
  }

  // فصلُ المهام (SOD): المُقرِّر ليس المُنشئ. يحرسه CHECK بنيوياً؛ نرفضه هنا برسالةٍ
  // مفهومة قبل بلوغ SQL.
  if (actor.userId === existing.requestedByUserId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "تعذّر حسم طلب الحوكمة",
        why: "المُقرِّرُ لا يجوز أن يكون هو المُنشئ — فصل المهام (SOD) يمنعه",
        doThis:
          "اطلب من مستخدمٍ آخر ذي صلاحيةٍ أن يحسم الطلب، أو اسحبه (WITHDRAWN) إن رجعتَ عن الطلب",
      }),
    });
  }

  const updateResult = await tx
    .update(controlRequests)
    .set({
      status: decision,
      decidedByUserId: actor.userId,
      decidedAt: sql`NOW()`,
      decisionNote: decisionNote || null,
    })
    .where(
      and(
        eq(controlRequests.id, requestId),
        eq(controlRequests.status, "PENDING"),
      ),
    );

  const affected = extractAffectedRows(updateResult);
  if (affected !== 1) {
    // سباقٌ خسر — طلبٌ حُسم بين قراءتنا وكتابتنا (رغم القفل، القارئُ بلا قفلٍ يفوز
    // مع READ COMMITTED). نرمي `CONFLICT` كي لا نُبلَّغ نجاحاً لم يقع.
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذّر حسم طلب الحوكمة",
        why: "الطلبُ حُسم للتوّ من جلسةٍ أخرى",
        doThis: "أعد تحميل الطلب لترى حالته الجديدة",
      }),
    });
  }

  const [updated] = await tx
    .select()
    .from(controlRequests)
    .where(eq(controlRequests.id, requestId))
    .limit(1);
  return updated!;
}

/**
 * يسحب الطالبُ طلبَه قبل الحسم (WITHDRAWN). للمُنشئ فقط. يحرس ذلك:
 *  - CHECK يقبل `decidedByUserId IS NULL` على `WITHDRAWN` (الساحبُ هو الطالبُ).
 *  - الخدمةُ ترفض ساحباً غير المُنشئ بـ`FORBIDDEN`.
 *  - `WHERE status = 'PENDING'` يمنع سحبَ طلبٍ محسوم.
 */
export async function withdrawControlRequest(
  tx: Tx,
  requestId: number,
  actor: Actor,
): Promise<ControlRequest> {
  assertIsTransaction(tx);
  assertActor(actor);

  if (!Number.isInteger(requestId) || requestId <= 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر سحب طلب الحوكمة",
        why: `معرّفُ الطلب ليس عدداً صحيحاً موجباً (${String(requestId)})`,
        doThis: "مرّر مُعرّفَ طلبٍ قائم",
      }),
    });
  }

  const [existing] = await tx
    .select()
    .from(controlRequests)
    .where(eq(controlRequests.id, requestId))
    .for("update")
    .limit(1);

  if (!existing) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: appErrorMessage({
        what: "تعذّر سحب طلب الحوكمة",
        why: `الطلبُ رقم ${requestId} غير موجود`,
        doThis: "تحقّق من المعرّف أو أعد تحميل قائمة طلباتك النشطة",
      }),
    });
  }

  if (existing.status !== "PENDING") {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذّر سحب طلب الحوكمة",
        why: `الطلبُ رقم ${requestId} محسومٌ بالفعل (حالته ${existing.status})`,
        doThis: "لا يُعاد فتح الطلبات المحسومة — افتح طلباً جديداً إن لزم",
      }),
    });
  }

  if (existing.requestedByUserId !== actor.userId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "تعذّر سحب طلب الحوكمة",
        why: "السحبُ حقٌّ للمُنشئ وحده — أنتَ لستَ مُنشئ هذا الطلب",
        doThis: "اطلب من المُنشئ أن يسحبه، أو انتظر قرار المُقرِّر",
      }),
    });
  }

  const updateResult = await tx
    .update(controlRequests)
    .set({
      status: "WITHDRAWN",
      // decidedByUserId يبقى NULL بحكم التعريف (الساحبُ = الطالبُ).
      decidedAt: sql`NOW()`,
    })
    .where(
      and(
        eq(controlRequests.id, requestId),
        eq(controlRequests.status, "PENDING"),
      ),
    );

  const affected = extractAffectedRows(updateResult);
  if (affected !== 1) {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذّر سحب طلب الحوكمة",
        why: "الطلبُ حُسم للتوّ من جلسةٍ أخرى",
        doThis: "أعد تحميل الطلب لترى حالته الجديدة",
      }),
    });
  }

  const [updated] = await tx
    .select()
    .from(controlRequests)
    .where(eq(controlRequests.id, requestId))
    .limit(1);
  return updated!;
}

/**
 * يقرأ الطلبَ النشط (PENDING) على قرارٍ/كيانٍ إن وُجد. للاستعلام قبل الفتح أو للعرض
 * في شاشاتٍ لاحقة. يُرجع `null` إن لم يوجد. **قراءةٌ محضة** — بلا قفلٍ، لأنّ الفحص
 * المسبق قبل الفتح يُتبَع بـUNIQUE constraint يفرض الحقيقة النهائية.
 */
export async function readActiveControlRequestFor(
  tx: Tx,
  decisionKey: string,
  entityType: string,
  entityId: number,
): Promise<ControlRequest | null> {
  assertIsTransaction(tx);
  const rows = await tx
    .select()
    .from(controlRequests)
    .where(
      and(
        eq(controlRequests.decisionKey, decisionKey.trim()),
        eq(controlRequests.entityType, entityType.trim()),
        eq(controlRequests.entityId, entityId),
        eq(controlRequests.status, "PENDING"),
      ),
    )
    .orderBy(desc(controlRequests.requestedAt))
    .limit(1);
  return rows[0] ?? null;
}
