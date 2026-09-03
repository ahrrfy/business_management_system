/**
 * ═══ اللقطة والاستعادة (م٦ ق٨ من برنامج v2، هجرة 0330) ═══
 *
 * **المبدأ الحاكم:** لا لقطة ⇒ لا تعديل. كل تعديلٍ لكيانٍ مرجعيٍّ (منتج/عميل/…) يجب أن
 * يُنشئ صفَّ لقطةٍ داخل نفس المعاملة، يحمل الحمولةَ الكاملة قبل التعديل. الاستعادةُ =
 * تعديلٌ جديدٌ يحمل حمولةَ إصدارٍ قديمٍ ويمرّ بكلّ حرّاس التعديل — لا كتابةٌ خامٌّ للجدول
 * الأصل ولا محوٌ للتاريخ.
 *
 * **الثابت المحروس:** `snapshotBeforeUpdate` تفشل **مغلقةً** — بلا سبب، أو بلا معاملة،
 * أو حين تسقط الكتابة لأيّ سبب. الاقتطاعُ ممنوعٌ — الحمولة تُحفظ كاملةً أو ترمي.
 *
 * ⛔ الخدمةُ **لا تقرأ `ctx`** — تستقبل `Actor` صريحاً (§٥ من CLAUDE.md).
 * ⛔ رقمُ الإصدار يتصاعد ذرّياً داخل المعاملة عبر `MAX(versionNumber)+1` تحت قفلٍ ضمنيّ
 *    بفهرس UNIQUE (entityType, entityId, versionNumber): سباقان يخرجان برقمَين مختلفَين
 *    حتماً، وحين يصطدمان فالثاني يُعيد المحاولة.
 *
 * **حدود م٦:** الاستعادة `restoreToVersion` تقبل `applyRestore` صريحاً — القرار **مَن
 * ينفّذ التعديل** يبقى للمستدعي كي لا نجرّ استيراداً دورياً بين `versioning/` وكلّ خدمة
 * كتابة (customerService/productUpdate/…). التوصيلُ الشامل موجةٌ لاحقة.
 */
import { TRPCError } from "@trpc/server";
import { and, asc, eq, sql } from "drizzle-orm";

import { recordVersions, type InsertRecordVersion, type RecordVersion } from "../../../drizzle/schema";
import { appErrorMessage } from "@shared/errors";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import type { Actor } from "../tx";

/**
 * حمولةُ إدخال لقطةٍ جديدة. `payloadJson` أيّ قيمةٍ قابلةٍ للتحويل إلى JSON (كائن،
 * مصفوفة، سلسلة، رقم، Boolean). التواريخُ عبر `toJSON()` إلى ISO، وقيم `Decimal.js`
 * عبر `toJSON()` إلى سلسلةٍ نصّية — كلاهما آمنٌ على الرحلة round-trip.
 */
export interface SnapshotBeforeUpdateInput {
  /** نوع الكيان — `product` | `customer` | `supplier` | `user` | … */
  entityType: string;
  /** معرّف الكيان في جدوله الأصلي. */
  entityId: number;
  /** الحمولة الكاملة **قبل** التعديل — الصفّ الحيّ كما قُرئ ضمن المعاملة. */
  payloadJson: unknown;
  /** سببُ التعديل. **إلزاميّ** — بلاه ترمي `BAD_REQUEST`. */
  reason: string;
}

/**
 * فحصُ أنّ `tx` معاملةٌ فعلاً لا اتصالٌ خامّ. `Tx` في drizzle-mysql2 صنفٌ يحوي
 * `rollback()`؛ الاتصالُ الخامّ (`DB`) لا يحويها. يمنع هذا الفحصُ سرباً صامتاً حين
 * يمرّر مستدعٍ `getDb()` بدل تسليم `tx` من `withTx` — الفشلُ **خارج معاملة** يُبقي
 * اللقطةَ منفردةً بلا الكتابة التي كان يفترض أن تصحبها، فينكسر الثابتُ الحاكم.
 *
 * ملاحظة: الفحصُ دفاعٌ متعمّق — عقدُ TypeScript يمنعه أصلاً (المعامل من نوع `Tx`)،
 * لكن مستدعياً غير مُنمَّط (`.js`/استيراد ديناميكيّ) قد يفلت.
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
        what: "تعذّر تسجيل لقطة",
        why: "الاستدعاء وقع خارج معاملة قاعدة البيانات",
        doThis: "استعمل الخدمة داخل `withTx(async (tx) => …)` وسلّم `tx` نفسه",
      }),
    });
  }
}

/**
 * Codex #963 P2: يفحص الحمولةَ قبل تخزينها ويرفض قيماً **يبتلعها** `JSON.stringify` صامتاً:
 *   • `undefined` في مفتاح كائن ⇒ يُحذف الحقل نهائياً.
 *   • `Function`/`Symbol` كقيمة ⇒ يُحذف الحقل نهائياً.
 *   • `NaN`/`±Infinity` ⇒ تُحوَّل إلى `null` (الاستعادةُ تصير خطأً صامتاً).
 * ابتلاعُ أيٍّ من هذه يخرق عقدَ اللقطة الكامل (§٦ ق٨: «كاملاً أو لا شيء»)، فنرفضها.
 */
function assertPayloadLossless(payload: unknown, path = "$"): void {
  if (payload === null || payload === undefined) {
    if (payload === undefined && path === "$") {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: appErrorMessage({
          what: "تعذّر تسجيل لقطة",
          why: "الحمولة الجذرية `undefined` — JSON.stringify ينتج `undefined` بلا حقل",
          doThis: "مرّر كائناً أو مصفوفةً، ولو فارغَين",
        }),
      });
    }
    return;
  }
  const t = typeof payload;
  if (t === "number") {
    if (!Number.isFinite(payload as number)) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: appErrorMessage({
          what: "تعذّر تسجيل لقطة",
          why: `قيمة عددية غير منتهية عند ${path} — JSON يحوّلها إلى \`null\` صامتاً`,
          doThis: "استعمل Decimal أو نصّاً للأعداد الحسّاسة، وتحقّق من مصدرها قبل التمرير",
        }),
      });
    }
    return;
  }
  if (t === "function" || t === "symbol" || t === "bigint") {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: appErrorMessage({
        what: "تعذّر تسجيل لقطة",
        why: `قيمة من نوع ${t} عند ${path} — JSON يبتلعها أو يرمي`,
        doThis: "حوّلها إلى نصٍّ أو رقم قبل التمرير",
      }),
    });
  }
  if (t !== "object") return;
  // Date/Decimal لهما .toJSON — نُبقيهما.
  if (payload instanceof Date || (payload as { toJSON?: unknown }).toJSON) return;
  if (Array.isArray(payload)) {
    payload.forEach((v, i) => assertPayloadLossless(v, `${path}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    if (v === undefined) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: appErrorMessage({
          what: "تعذّر تسجيل لقطة",
          why: `الحقل ${path}.${k} = undefined — JSON.stringify يحذفه من اللقطة`,
          doThis: "استعمل `null` صراحةً بدلاً من `undefined`، أو أزل الحقل من المصدر",
        }),
      });
    }
    assertPayloadLossless(v, `${path}.${k}`);
  }
}

/**
 * يحوّل الحمولةَ إلى JSON آمنٍ للتخزين — يفرض المرورَ عبر `JSON.stringify/parse` كي
 * تُحلّ `Date.toJSON()` (ISO) و`Decimal.toJSON()` (سلسلة نصّية) قبل الكتابة، ويرفض
 * قيمةً غير قابلةٍ للتحويل (دورةٌ مرجعية، BigInt خامّ) **أو** قيمةً يبتلعها JSON صامتاً.
 */
function normalizePayload(payload: unknown): unknown {
  assertPayloadLossless(payload);
  try {
    return JSON.parse(JSON.stringify(payload));
  } catch (err) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: appErrorMessage({
        what: "تعذّر تسجيل لقطة",
        why: `الحمولة غير قابلةٍ للتحويل إلى JSON (${(err as Error)?.message ?? "سبب غير معروف"})`,
        doThis: "مرّر كائناً عادياً أو مصفوفةً — بلا دوراتٍ مرجعية أو BigInt خامّ",
      }),
    });
  }
}

/**
 * يسجّل صفَّ لقطةٍ للحالة الحاليّة (قبل التعديل) داخل المعاملة الحاليّة. يُرجع
 * `versionNumber` و`id` الجديدَين.
 *
 * ⛔ **يفشل مغلقاً**:
 *  - بلا سبب (فارغ أو مسافات بيضاء): `BAD_REQUEST`.
 *  - خارج معاملة: `INTERNAL_SERVER_ERROR`.
 *  - حين تسقط الكتابة لأيّ سبب: يرمي (لا يبتلع).
 *
 * الاقتطاعُ ممنوع: `payloadJson` تُخزَّن كاملةً — طول العمود JSON في MySQL كافٍ حتّى
 * ٤ غيغابايت نظرياً، والحدُّ التطبيقيّ يمرّ عبر `max_allowed_packet` وحده. لا نحدُّه
 * صراحةً كي لا يبتلع الحارسُ حمولةً واسعة (المدفوع الأول من عقد اللقطة: الكاملُ أو لا شيء).
 */
export async function snapshotBeforeUpdate(
  tx: Tx,
  input: SnapshotBeforeUpdateInput,
  actor: Actor,
): Promise<{ id: number; versionNumber: number }> {
  assertIsTransaction(tx);

  const entityType = input.entityType.trim();
  if (!entityType) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر تسجيل لقطة",
        why: "نوعُ الكيان `entityType` فارغ",
        doThis: "سلّم نوعاً غير فارغ (مثل `customer` أو `product`)",
      }),
    });
  }

  if (!Number.isInteger(input.entityId) || input.entityId <= 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر تسجيل لقطة",
        why: `معرّف الكيان \`entityId\` ليس عدداً صحيحاً موجباً (${String(input.entityId)})`,
        doThis: "مرّر مُعرّفَ صفٍّ قائمٍ من جدول الكيان",
      }),
    });
  }

  const reason = (input.reason ?? "").trim();
  if (!reason) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر تسجيل لقطة",
        why: "سببُ التعديل مطلوب — «لا لقطة ⇒ لا تعديل»",
        doThis: "مرّر سبباً مكتوباً يشرح لماذا وقع التعديل (يظهر في سجلّ الاستعادة)",
      }),
    });
  }
  if (reason.length > 500) {
    // الاقتطاع مرفوضٌ — نرمي بدل ابتلاع نصفَ سببٍ يُضلّل مَن يقرأ التاريخ.
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر تسجيل لقطة",
        why: `طولُ السبب ${reason.length} محرف — الحدّ الأقصى 500 محرف`,
        doThis: "اختصر السبب أو انقل التفاصيل إلى ملاحظةٍ مستقلّة",
      }),
    });
  }

  const payload = normalizePayload(input.payloadJson);

  // رقمُ الإصدار = MAX + 1 داخل المعاملة. UNIQUE(entityType,entityId,versionNumber)
  // يحرس التزامن: سباقٌ نادر يُلقي `ER_DUP_ENTRY` فيسقط الـTx كاملاً — والسبب المكشوف
  // للمستدعي أفضل من كتابةٍ متأخّرة بمعرّفٍ خاطئ.
  const [{ maxVersion }] = await tx
    .select({ maxVersion: sql<number | null>`COALESCE(MAX(${recordVersions.versionNumber}), 0)` })
    .from(recordVersions)
    .where(
      and(
        eq(recordVersions.entityType, entityType),
        eq(recordVersions.entityId, input.entityId),
      ),
    );
  const versionNumber = Number(maxVersion ?? 0) + 1;

  const row: InsertRecordVersion = {
    entityType,
    entityId: input.entityId,
    versionNumber,
    payloadJson: payload as InsertRecordVersion["payloadJson"],
    reason,
    actorUserId: actor.userId,
    branchId: actor.branchId ?? null,
  };

  const insertResult = await tx.insert(recordVersions).values(row);
  const id = extractInsertId(insertResult);
  return { id, versionNumber };
}

/**
 * يقرأ تاريخ إصدارات كيان تصاعدياً (versionNumber 1..N). للقارئ فقط — لا يعدّل شيئاً.
 * القراءة **بلا قفل** لأنّ الجدول append-only بحكم عدم توفير مسار UPDATE في هذه الخدمة.
 */
export async function readVersionHistory(
  tx: Tx,
  entityType: string,
  entityId: number,
): Promise<RecordVersion[]> {
  assertIsTransaction(tx);
  return tx
    .select()
    .from(recordVersions)
    .where(
      and(
        eq(recordVersions.entityType, entityType.trim()),
        eq(recordVersions.entityId, entityId),
      ),
    )
    .orderBy(asc(recordVersions.versionNumber));
}

/**
 * يقرأ إصداراً بعينه. يرمي `NOT_FOUND` إن لم يوجد.
 */
export async function readVersion(
  tx: Tx,
  entityType: string,
  entityId: number,
  versionNumber: number,
): Promise<RecordVersion> {
  assertIsTransaction(tx);
  const rows = await tx
    .select()
    .from(recordVersions)
    .where(
      and(
        eq(recordVersions.entityType, entityType.trim()),
        eq(recordVersions.entityId, entityId),
        eq(recordVersions.versionNumber, versionNumber),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: appErrorMessage({
        what: "تعذّرت الاستعادة",
        why: `الإصدار (${versionNumber}) للكيان \`${entityType}\`#${entityId} غير موجود`,
        doThis: "افتح تاريخ الكيان واختر إصداراً موجوداً",
      }),
    });
  }
  return row;
}

/**
 * دالّةُ تطبيقٍ للاستعادة: يستقبلها المستدعي كي تُعيد كتابة الكيان بحمولةٍ قديمة
 * عبر **مسار التعديل الرسميّ** (لا كتابةٌ خامٌّ للجدول الأصل).
 *
 * لماذا callback لا استيراد مباشر: كي لا نجرّ دورةَ استيرادٍ بين `versioning/` وكلّ
 * خدمة كتابة (customerService/productUpdate/…) — القرارُ **مَن ينفّذ** يبقى للمستدعي.
 *
 * Codex #963 P2 (تعليقان):
 *  ① يستقبل `reason` صراحةً كي يستطيع المستدعي أن يُلحقه باللقطة الجديدة التي يكتبها.
 *     كان يُهدَر خفيةً قبل.
 *  ② يُرجع `{ updated: boolean }` كدليلٍ **قابلٍ للتحقّق** أنّ الاستعادةَ فعلت شيئاً.
 *     `restoreToVersion` يرفض `updated=false` بـ`INTERNAL_SERVER_ERROR` كي لا يُبلَّغ الموظّف
 *     بنجاحٍ لم يقع (callback فارغٌ أو مقيَّدٌ بحرّاسٍ يمنعان الكتابة).
 */
export type RestoreApply = (
  tx: Tx,
  payload: unknown,
  actor: Actor,
  restoreReason: string,
) => Promise<{ updated: boolean }>;

export interface RestoreToVersionInput {
  entityType: string;
  entityId: number;
  versionNumber: number;
  /** سببٌ يُلحق باللقطة الجديدة التي ينشئها التعديلُ نفسه (يُشرح للتاريخ). */
  reason?: string;
  applyRestore: RestoreApply;
}

/**
 * يستعيد كياناً إلى إصدارٍ قديم عبر تعديلٍ جديد يمرّ بكلّ حرّاس التعديل.
 *
 * الترتيب داخل المعاملة:
 *  1) اقرأ حمولة الإصدار المطلوب — يرمي `NOT_FOUND` إن غاب.
 *  2) استدعِ `applyRestore(tx, payload, actor)` — المستدعي يتحمّل التطبيق (الذي
 *     بدوره **يجب** أن يستدعي `snapshotBeforeUpdate` قبل الكتابة، تماماً كأيّ تعديل
 *     آخر). الخدمة **لا تكتب** أيّ صفٍّ إضافيّ للقطة هنا — التعديلُ يكتبها.
 *
 * ⛔ لا يجوز للـ`applyRestore` أن يكتب بمسارٍ خامٍّ للجدول الأصل — يجب أن يعبر بواباتِ
 *    التعديل الرسميّة (حرّاس/بوّابات/idempotency).
 */
export async function restoreToVersion(
  tx: Tx,
  input: RestoreToVersionInput,
  actor: Actor,
): Promise<{ restoredFromVersion: number }> {
  assertIsTransaction(tx);

  const version = await readVersion(
    tx,
    input.entityType,
    input.entityId,
    input.versionNumber,
  );

  const restoreReason = (input.reason ?? "").trim() || `استعادة إلى الإصدار ${input.versionNumber}`;

  // Codex #963 P2: `applyRestore` صار عقدُه `{ updated: boolean }` — نرفض ادّعاء استعادةٍ لم
  // تكتب. المُنفّذُ (customerService مثلاً) يُقفل بـ`snapshotBeforeUpdate` قبل الكتابة ثمّ
  // يستدعي `updateEntity(...)` ويُعيد `{ updated: rows.affected > 0 }`.
  const result = await input.applyRestore(tx, version.payloadJson, actor, restoreReason);
  if (!result.updated) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: appErrorMessage({
        what: "تعذّرت الاستعادة",
        why: "دالّةُ التطبيق لم تُبلِّغ عن أيّ صفٍّ محدَّث — قد يكون هناك حارسٌ منع الكتابة",
        doThis: "افتح الكيان الآن وتحقّق من حالتِه، وابلغ المدير إن لم تظهر الاستعادة",
      }),
    });
  }

  return { restoredFromVersion: input.versionNumber };
}
