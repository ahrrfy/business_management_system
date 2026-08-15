// طلب إقفال الشهر واعتماده (ش٥ب من docs/double-entry-p2-plan-2026-08-11.md).
//
// قرار المالك (١١/٨): **المدير يطلُب، والأدمن/المالك يُقفل**، و**لا تجاوز للحاجز إطلاقاً**.
// السبب مكتشَفٌ من الكود: `lockPeriod` عامٌّ على الشركة كلّها (`financialPeriods` بلا branchId)
// ومحصورٌ بـadminProcedure منذ بنائه ⇒ فتحُه للمدير إضعافُ ضابطٍ قائم.
//
// ثلاثة ثوابت حاكمة:
//  ١) **الجاهزية تُحسب لكل الفروع دائماً** (branchId=null مفروضاً هنا لا بخيار الواجهة): القفل عامّ،
//     فجاهزيةٌ مُنطَّقةٌ بفرع الطالب كانت ستُجيز الإقفال وفرعٌ آخر فيه وردية مفتوحة.
//  ٢) **الفحص يُعاد حيّاً عند الاعتماد** ولا يُصدَّق `readinessSnapshot` المخزَّن (هو للتدقيق فقط):
//     قد تُفتَح وردية بين الطلب والاعتماد. نفس منطق اللقطة التفاؤلية في stockAdjustmentRequests.
//  ٣) **الطالب ≠ المعتمِد** (فصل مهام، نمط النظام المعتمَد).
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import {
  financialPeriods,
  monthCloseRequests,
  users,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import {
  getDoubleEntryRuntime,
  type DoubleEntryRuntime,
} from "../accounting/journalStore";
import { baghdadToday } from "../businessDay";
import { money, round2, toDbMoney } from "../money";
import { getActiveLock, lockPeriod } from "../periodLockService";
import { reconcileDoubleEntry } from "../reconcileService";
import { createMonthCloseCertificate } from "./monthCloseCertificate";
import { lockCompanyMonthCloseGate } from "./monthCloseGate";
import { getMonthCloseReadiness } from "./monthCloseReadiness";
import {
  advanceMonthCloseSequence,
  assertExpectedCloseMonth,
  getMonthCloseSequence,
  nextCloseRevision,
} from "./monthCloseSequence";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface MonthCloseRequestRow {
  id: number;
  month: string;
  status: "PENDING_APPROVAL" | "APPROVED" | "REJECTED";
  requestedBy: number;
  requestedByName: string;
  requestedAt: Date;
  decidedBy: number | null;
  decidedByName: string | null;
  decidedAt: Date | null;
  rejectionReason: string | null;
  lockedPeriodId: number | null;
  /** حقيقة حيّة مشتقّة من القفل المرتبط، لا من كون الطلب اعتُمِد تاريخياً. */
  locked: boolean;
}

/** نهاية الشهر (YYYY-MM-DD) — تاريخ القطع الذي يُقفَل عنده. */
function monthCutoff(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(lastDay).padStart(2, "0")}`;
}

/** هل انتهى الشهر عند التقويم المدني للشركة في بغداد؟ قابلة لحقن الزمن لاختبار حدّ الشهر. */
export function hasMonthEndedInBaghdad(
  month: string,
  now: Date = new Date(),
): boolean {
  return monthCutoff(month) < baghdadToday(now);
}

function assertCloseableMonth(month: string, now: Date = new Date()): void {
  if (!MONTH_RE.test(month)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "صيغة الشهر غير صالحة (YYYY-MM).",
    });
  }
  if (!hasMonthEndedInBaghdad(month, now)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "لا يُقفَل شهرٌ لم ينتهِ بعد.",
    });
  }
}

/** يرمي إن كان الشهر محجوزاً، ويعيد اللقطة إن كان سالكاً. */
async function assertReadyOrThrow(
  month: string,
  options?: { tx?: Tx; lockBlockers?: boolean },
) {
  // branchId=null دائماً: القفل عامّ ⇒ الجاهزية عامّة (الثابت ١).
  const readiness = await getMonthCloseReadiness(
    { month, branchId: null },
    options,
  );
  if (readiness.blocked) {
    const blockers = readiness.items
      .filter((i) => i.status === "BLOCK")
      .map((i) => i.label)
      .join(" · ");
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `لا يُقفَل الشهر ${month} — بنودٌ حاجزة قائمة: ${blockers}. عالجها ثم أعِد المحاولة.`,
    });
  }
  return readiness;
}

async function assertActiveCloseIntegrity(
  tx: Tx,
  month: string,
  runtime: DoubleEntryRuntime,
) {
  if (runtime.mode !== "ACTIVE") return null;

  const reconciliation = await reconcileDoubleEntry(
    { month, branchId: null },
    { tx },
  );
  const trialBalanceDifference = round2(
    reconciliation.roles.reduce(
      (sum, role) => sum.plus(money(role.actual)),
      money(0),
    ),
  );
  if (!reconciliation.ok || !trialBalanceDifference.isZero()) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        `لا يمكن إقفال ${month}: فشلت مطابقة الدفتر المزدوج ` +
        `(missing=${reconciliation.missingCount}, extra=${reconciliation.extraCount}, ` +
        `scope=${reconciliation.scopeMismatchCount}, source=${reconciliation.sourceMismatchCount}, ` +
        `unreconstructable=${reconciliation.unreconstructableCount}, journals=${reconciliation.imbalancedJournalCount}, ` +
        `trialBalance=${toDbMoney(trialBalanceDifference)}).`,
    });
  }
  return {
    ...reconciliation,
    trialBalanceDifference: toDbMoney(trialBalanceDifference),
  };
}

/**
 * المدير يطلُب إقفال شهر. يفشل إن كان محجوزاً (فحصٌ **خادميّ** — لا يُصدَّق ادّعاء الواجهة)،
 * وقيد `uq_month_close_pending` يمنع طلبين معلَّقين لنفس الشهر بنيوياً (لا بفحصٍ تطبيقيّ).
 */
export async function requestMonthClose(
  tx: Tx,
  input: { month: string; requestedBy: number; now?: Date },
): Promise<{ id: number }> {
  assertCloseableMonth(input.month, input.now);

  // الطلب والقفل عمليتان على مستوى الشركة. نمسك بوابة الشركة نفسها التي يمسكها الاعتماد كي لا
  // يتسابق طلبٌ جديد مع اعتمادٍ يضع القفل في اللحظة ذاتها، ثم نرفض كل شهر يغطيه القفل الحي.
  // pendingGuard يمنع الطلبات المعلّقة المتزامنة فقط؛ بعد الاعتماد يصير NULL، لذلك لا يغني عن
  // هذا الفحص (وإلا أمكن إنشاء طلبٍ عالق لشهر ما يزال مقفلاً).
  await lockCompanyMonthCloseGate(tx);
  const runtime = await getDoubleEntryRuntime(tx);
  const sequence = await getMonthCloseSequence(tx, { forUpdate: true });
  assertExpectedCloseMonth(sequence, input.month);
  const cutoffDate = monthCutoff(input.month);
  const activeLock = await getActiveLock(tx);
  if (activeLock && cutoffDate <= activeLock.cutoffDate) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `الشهر ${input.month} مقفَل بالفعل ضمن القفل حتى ${activeLock.cutoffDate}. افتح أحدث قفل أولاً قبل طلب إعادة الإقفال.`,
    });
  }

  const readiness = await assertReadyOrThrow(input.month, {
    tx,
    lockBlockers: true,
  });
  const doubleEntryIntegrity = await assertActiveCloseIntegrity(
    tx,
    input.month,
    runtime,
  );
  const closeRevision = await nextCloseRevision(tx, input.month);

  const res = await tx.insert(monthCloseRequests).values({
    month: input.month,
    status: "PENDING_APPROVAL",
    readinessSnapshot: JSON.stringify({ ...readiness, doubleEntryIntegrity }),
    requestedBy: input.requestedBy,
    closeRevision,
    requestedSequenceVersion: sequence.version,
    // الحارس يحمل الشهر ما دام الطلب معلَّقاً (نمط shifts.openGuard) ⇒ طلبٌ ثانٍ متزامنٌ لنفس
    // الشهر يفشل بـER_DUP_ENTRY على مستوى القاعدة، لا بفحصٍ تطبيقيٍّ قابلٍ للسباق.
    pendingGuard: input.month,
  });
  return { id: extractInsertId(res) };
}

/**
 * الأدمن/المالك يعتمد الطلب فيُقفل الفترة فعلاً. **يُعيد فحص الجاهزية حيّاً** ويرفض الطالبَ نفسه.
 * القفل والحسم في **نفس المعاملة** ⇒ لا طلبٌ «مُعتمَد» بلا قفل ولا العكس.
 */
export async function approveMonthClose(
  tx: Tx,
  input: {
    requestId: number;
    decidedBy: number;
    notes?: string | null;
    now?: Date;
  },
): Promise<{
  periodId: number;
  certificateId: number;
  certificateNumber: string;
  month: string;
  revision: number;
  cutoffDate: string;
}> {
  // في ACTIVE يحتاج ديسمبر قيد الإقفال السنوي قبل قفل 31/12. نقرأ الشهر أولاً ثم نمسك إعدادات
  // الدفتر بقفلها المشترك قبل صف الطلب، اتساقاً مع ترتيب الإقفال السنوي ومنعاً لقفلين متعاكسين.
  await lockCompanyMonthCloseGate(tx);
  const runtime = await getDoubleEntryRuntime(tx);
  const req = (
    await tx
      .select()
      .from(monthCloseRequests)
      .where(eq(monthCloseRequests.id, input.requestId))
      .for("update")
      .limit(1)
  )[0];
  if (!req) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "طلب الإقفال غير موجود.",
    });
  }
  if (req.status !== "PENDING_APPROVAL") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "هذا الطلب مَحسومٌ مسبقاً — لا يُعاد اعتماده.",
    });
  }
  if (req.month.endsWith("-12") && runtime.mode === "ACTIVE") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "إقفال ديسمبر في وضع ACTIVE يتم حصراً من شاشة الإقفال السنوي بعد ترحيل قيد الإقفال.",
    });
  }

  const sequence = await getMonthCloseSequence(tx, { forUpdate: true });
  assertExpectedCloseMonth(sequence, req.month);
  // فصل المهام: من طلب لا يعتمد. لا استثناء للأدمن هنا — القفل عامٌّ ولا رجعة فيه إلا بفتحٍ موثَّق.
  if (Number(req.requestedBy) === input.decidedBy) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "لا تعتمد طلبك — يعتمده مسؤولٌ آخر (فصل المهام).",
    });
  }
  if (
    req.requestedSequenceVersion == null ||
    Number(req.requestedSequenceVersion) !== sequence.version ||
    req.closeRevision == null
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "تغير تسلسل الإقفال منذ إنشاء الطلب؛ ارفض الطلب وأنشئ طلباً جديداً.",
    });
  }

  // الثابت ٢: بوابة الشركة تتسلسل مع كتّاب الورديات/السندات، ثم يُعاد الفحص حيّاً
  // وبـFOR UPDATE داخل **نفس** معاملة الاعتماد؛ لا اتصال منفصل ولا لقطة MVCC قديمة.
  const approvalReadiness = await assertReadyOrThrow(req.month, {
    tx,
    lockBlockers: true,
  });
  const doubleEntryIntegrity = await assertActiveCloseIntegrity(
    tx,
    req.month,
    runtime,
  );

  const cutoffDate = monthCutoff(req.month);
  const decidedAt = new Date(
    Math.floor((input.now ?? new Date()).getTime() / 1_000) * 1_000,
  );
  const { id: periodId } = await lockPeriod(tx, {
    cutoffDate,
    lockedBy: input.decidedBy,
    lockedAt: decidedAt,
    closeMonth: req.month,
    closeRevision: Number(req.closeRevision),
    predecessorPeriodId: sequence.activePeriodId,
    notes: input.notes ?? `إقفال شهر ${req.month} — اعتماد الطلب #${req.id}`,
  });

  const certificate = await createMonthCloseCertificate(tx, {
    kind: "MONTH_CLOSE",
    request: {
      id: Number(req.id),
      month: req.month,
      readinessSnapshot: req.readinessSnapshot,
      requestedBy: Number(req.requestedBy),
      requestedAt: req.requestedAt,
    },
    revision: Number(req.closeRevision),
    periodId,
    approvedBy: input.decidedBy,
    approvedAt: decidedAt,
    approvalReadiness,
    doubleEntryIntegrity,
    runtime,
  });

  await tx
    .update(monthCloseRequests)
    .set({
      status: "APPROVED",
      decidedBy: input.decidedBy,
      decidedAt,
      lockedPeriodId: periodId,
      pendingGuard: null, // حُسم ⇒ يُحرَّر الحارس
    })
    .where(eq(monthCloseRequests.id, input.requestId));

  await advanceMonthCloseSequence(tx, {
    state: sequence,
    month: req.month,
    revision: Number(req.closeRevision),
    periodId,
    requestId: Number(req.id),
    certificateId: certificate.id,
    actorId: input.decidedBy,
    occurredAt: decidedAt,
  });

  return {
    periodId,
    certificateId: certificate.id,
    certificateNumber: certificate.certificateNumber,
    month: req.month,
    revision: Number(req.closeRevision),
    cutoffDate,
  };
}

/**
 * قرارٌ مختصر لزرّ الطلب العام: يحسب الشركة كلّها ولا يعيد أسماء الحواجز أو بيانات الفروع.
 * الشهر الجاري/المستقبل أو الشهر المغطّى بقفل حي محجوب كذلك، كي لا تعرض الواجهة مساراً
 * سيرفضه requestMonthClose حتماً.
 */
export async function getCompanyCloseActionReadiness(
  tx: Tx,
  month: string,
  now: Date = new Date(),
): Promise<{ month: string; blocked: boolean }> {
  if (!MONTH_RE.test(month)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "صيغة الشهر غير صالحة (YYYY-MM).",
    });
  }
  if (!hasMonthEndedInBaghdad(month, now)) return { month, blocked: true };

  const sequence = await getMonthCloseSequence(tx);
  if (sequence.status !== "READY" || sequence.nextRequiredMonth !== month) {
    return { month, blocked: true };
  }

  const activeLock = await getActiveLock(tx);
  if (activeLock && monthCutoff(month) <= activeLock.cutoffDate)
    return { month, blocked: true };

  const readiness = await getMonthCloseReadiness(
    { month, branchId: null },
    { tx },
  );
  return { month: readiness.month, blocked: readiness.blocked };
}

/** رفض الطلب بسببٍ مكتوب — يحرّر الشهر لطلبٍ جديد (pendingGuard يصير NULL). */
export async function rejectMonthClose(
  tx: Tx,
  input: { requestId: number; decidedBy: number; reason: string },
): Promise<void> {
  const reason = input.reason.trim();
  if (reason.length < 5) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "سبب الرفض إلزامي (٥ أحرف على الأقل).",
    });
  }
  const req = (
    await tx
      .select()
      .from(monthCloseRequests)
      .where(eq(monthCloseRequests.id, input.requestId))
      .for("update")
      .limit(1)
  )[0];
  if (!req)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "طلب الإقفال غير موجود.",
    });
  if (req.status !== "PENDING_APPROVAL") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "هذا الطلب مَحسومٌ مسبقاً.",
    });
  }

  await tx
    .update(monthCloseRequests)
    .set({
      status: "REJECTED",
      decidedBy: input.decidedBy,
      decidedAt: new Date(),
      rejectionReason: reason,
      pendingGuard: null, // حُسم ⇒ الشهر يقبل طلباً جديداً
    })
    .where(eq(monthCloseRequests.id, input.requestId));
}

/** طابور الطلبات — المعلَّقة أولاً ثم الأحدث. */
export async function listMonthCloseRequests(
  tx: Tx,
  opts?: { pendingOnly?: boolean },
): Promise<MonthCloseRequestRow[]> {
  const requester = { id: users.id, name: users.name };
  const rows = await tx
    .select({
      id: monthCloseRequests.id,
      month: monthCloseRequests.month,
      status: monthCloseRequests.status,
      requestedBy: monthCloseRequests.requestedBy,
      requestedAt: monthCloseRequests.requestedAt,
      decidedBy: monthCloseRequests.decidedBy,
      decidedAt: monthCloseRequests.decidedAt,
      rejectionReason: monthCloseRequests.rejectionReason,
      lockedPeriodId: monthCloseRequests.lockedPeriodId,
      lockedPeriodStatus: financialPeriods.status,
      requestedByName: requester.name,
    })
    .from(monthCloseRequests)
    .leftJoin(users, eq(users.id, monthCloseRequests.requestedBy))
    .leftJoin(
      financialPeriods,
      eq(financialPeriods.id, monthCloseRequests.lockedPeriodId),
    )
    .where(
      opts?.pendingOnly
        ? eq(monthCloseRequests.status, "PENDING_APPROVAL")
        : undefined,
    )
    .orderBy(desc(monthCloseRequests.requestedAt))
    .limit(100);

  return rows.map((r) => ({
    id: Number(r.id),
    month: r.month,
    status: r.status,
    requestedBy: Number(r.requestedBy),
    requestedByName: r.requestedByName ?? "—",
    requestedAt: r.requestedAt,
    decidedBy: r.decidedBy != null ? Number(r.decidedBy) : null,
    decidedByName: null, // اسم المعتمِد يُجلَب عند الحاجة — الطابور يعرض الطالب.
    decidedAt: r.decidedAt,
    rejectionReason: r.rejectionReason,
    lockedPeriodId: r.lockedPeriodId != null ? Number(r.lockedPeriodId) : null,
    locked: r.lockedPeriodStatus === "LOCKED",
  }));
}
