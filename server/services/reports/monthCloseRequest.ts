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
import { monthCloseRequests, users } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { todayUtcDate } from "../businessDay";
import { lockPeriod } from "../periodLockService";
import { lockCompanyMonthCloseGate } from "./monthCloseGate";
import { getMonthCloseReadiness } from "./monthCloseReadiness";

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
}

/** نهاية الشهر (YYYY-MM-DD) — تاريخ القطع الذي يُقفَل عنده. */
function monthCutoff(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(lastDay).padStart(2, "0")}`;
}

function assertCloseableMonth(month: string): void {
  if (!MONTH_RE.test(month)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "صيغة الشهر غير صالحة (YYYY-MM)." });
  }
  if (monthCutoff(month) >= todayUtcDate()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "لا يُقفَل شهرٌ لم ينتهِ بعد." });
  }
}

/** يرمي إن كان الشهر محجوزاً، ويعيد اللقطة إن كان سالكاً. */
async function assertReadyOrThrow(month: string, options?: { tx?: Tx; lockBlockers?: boolean }) {
  // branchId=null دائماً: القفل عامّ ⇒ الجاهزية عامّة (الثابت ١).
  const readiness = await getMonthCloseReadiness({ month, branchId: null }, options);
  if (readiness.blocked) {
    const blockers = readiness.items.filter((i) => i.status === "BLOCK").map((i) => i.label).join(" · ");
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `لا يُقفَل الشهر ${month} — بنودٌ حاجزة قائمة: ${blockers}. عالجها ثم أعِد المحاولة.`,
    });
  }
  return readiness;
}

/**
 * المدير يطلُب إقفال شهر. يفشل إن كان محجوزاً (فحصٌ **خادميّ** — لا يُصدَّق ادّعاء الواجهة)،
 * وقيد `uq_month_close_pending` يمنع طلبين معلَّقين لنفس الشهر بنيوياً (لا بفحصٍ تطبيقيّ).
 */
export async function requestMonthClose(
  tx: Tx,
  input: { month: string; requestedBy: number },
): Promise<{ id: number }> {
  assertCloseableMonth(input.month);
  const readiness = await assertReadyOrThrow(input.month, { tx });

  const res = await tx.insert(monthCloseRequests).values({
    month: input.month,
    status: "PENDING_APPROVAL",
    readinessSnapshot: JSON.stringify(readiness),
    requestedBy: input.requestedBy,
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
  input: { requestId: number; decidedBy: number; notes?: string | null },
): Promise<{ periodId: number; month: string }> {
  const req = (
    await tx.select().from(monthCloseRequests).where(eq(monthCloseRequests.id, input.requestId)).for("update").limit(1)
  )[0];
  if (!req) throw new TRPCError({ code: "NOT_FOUND", message: "طلب الإقفال غير موجود." });
  if (req.status !== "PENDING_APPROVAL") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "هذا الطلب مَحسومٌ مسبقاً — لا يُعاد اعتماده." });
  }
  // فصل المهام: من طلب لا يعتمد. لا استثناء للأدمن هنا — القفل عامٌّ ولا رجعة فيه إلا بفتحٍ موثَّق.
  if (Number(req.requestedBy) === input.decidedBy) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "لا تعتمد طلبك — يعتمده مسؤولٌ آخر (فصل المهام).",
    });
  }

  // الثابت ٢: بوابة الشركة تتسلسل مع كتّاب الورديات/السندات، ثم يُعاد الفحص حيّاً
  // وبـFOR UPDATE داخل **نفس** معاملة الاعتماد؛ لا اتصال منفصل ولا لقطة MVCC قديمة.
  await lockCompanyMonthCloseGate(tx);
  await assertReadyOrThrow(req.month, { tx, lockBlockers: true });

  const { id: periodId } = await lockPeriod(tx, {
    cutoffDate: monthCutoff(req.month),
    lockedBy: input.decidedBy,
    notes: input.notes ?? `إقفال شهر ${req.month} — اعتماد الطلب #${req.id}`,
  });

  await tx
    .update(monthCloseRequests)
    .set({
      status: "APPROVED",
      decidedBy: input.decidedBy,
      decidedAt: new Date(),
      lockedPeriodId: periodId,
      pendingGuard: null, // حُسم ⇒ يُحرَّر الحارس
    })
    .where(eq(monthCloseRequests.id, input.requestId));

  return { periodId, month: req.month };
}

/** رفض الطلب بسببٍ مكتوب — يحرّر الشهر لطلبٍ جديد (pendingGuard يصير NULL). */
export async function rejectMonthClose(
  tx: Tx,
  input: { requestId: number; decidedBy: number; reason: string },
): Promise<void> {
  const reason = input.reason.trim();
  if (reason.length < 5) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "سبب الرفض إلزامي (٥ أحرف على الأقل)." });
  }
  const req = (
    await tx.select().from(monthCloseRequests).where(eq(monthCloseRequests.id, input.requestId)).for("update").limit(1)
  )[0];
  if (!req) throw new TRPCError({ code: "NOT_FOUND", message: "طلب الإقفال غير موجود." });
  if (req.status !== "PENDING_APPROVAL") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "هذا الطلب مَحسومٌ مسبقاً." });
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
      requestedByName: requester.name,
    })
    .from(monthCloseRequests)
    .leftJoin(users, eq(users.id, monthCloseRequests.requestedBy))
    .where(opts?.pendingOnly ? eq(monthCloseRequests.status, "PENDING_APPROVAL") : undefined)
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
  }));
}
