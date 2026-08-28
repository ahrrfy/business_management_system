import crypto from "node:crypto";
import { and, eq, or, sql } from "drizzle-orm";
import { users } from "../../drizzle/schema";
import { createAppNotification } from "./appNotificationService";
import { requireDb } from "./tx";

/**
 * ن-٢-هـ (٢٨/٨) — إشعارات دورة اعتماد السندات (Maker-Checker).
 *
 * القاعدة الحاكمة (نفس ن-٢-د في `sessionEventNotifier.ts`):
 *   1) عند إنشاء سندٍ `PENDING_APPROVAL`: يُخطَر كلُّ مالكٍ (`isOwner=true`) نشطٍ يستطيع
 *      اعتمادَه (approveVoucher يشترط `isOwner`)، مستثنى منه المُنشئُ نفسه — لا يعتمد
 *      شخصٌ سنداً أنشأه (SOD يرفضه في اللحظة، فلا معنى لإشعارٍ ينتهي بـFORBIDDEN).
 *   2) عند القرار (اعتماد أو رفض): يُخطَر المُنشئُ فقط بنتيجة سنده.
 *   3) idempotency: `eventKey` يعتمد على (receiptId + decision + recipientId) — إعادةُ
 *      اعتمادٍ replayed تولّد نفس المفتاح، فالإشعار لا يُنشَر ثانية (تفصيل: `createAppNotification`
 *      يعتمد على قيدٍ فريدٍ على eventKey في جدول `appNotifications`).
 *   4) fail-open: كلّ نقطةِ استدعاءٍ في الراوتر تُغلّف الاستدعاء بـtry/catch — فشلُ الإشعار
 *      لا يُعطّل الاعتماد ولا الإنشاء (المسار المالي لا يعتمد على قناة الإفصاح).
 *   5) الحمولةُ ماليّة (مبلغ + رقم سند) ⇒ `lockScreenSafe:false` (الافتراضي، فيحجب على
 *      شاشة القفل ويُعرض داخل التطبيق فقط).
 */

export type VoucherDirection = "IN" | "OUT";
export type ApprovalDecision = "APPROVED" | "REJECTED";

export interface ApprovalPendingInput {
  receiptId: number;
  voucherNumber: string;
  direction: VoucherDirection;
  /** المبلغ نصّاً (سلسلة decimal كما تُحفَظ). */
  amount: string;
  /** فرعُ السند — لا يُستعمل للتصفية (كلّ المالكين يعتمدون كل الفروع)، مخزَّن للسياق. */
  branchId: number | null;
  /** مُنشئ السند — يُستثنى من قائمة المستقبِلين. */
  createdBy: number | null;
  /** لحظةُ الإنشاء (تدخل في eventKey لتمييز محاولاتٍ نادرة بنفس receiptId عبر مسار خطأ/إعادة). */
  occurredAt: Date;
}

export interface ApprovalDecisionInput {
  receiptId: number;
  voucherNumber: string;
  direction: VoucherDirection;
  amount: string;
  /** APPROVED أو REJECTED. */
  decision: ApprovalDecision;
  /** المستقبِلُ = مُنشئ السند. `null` = لا مستقبِلَ معلوم فيُتخطّى صامتاً. */
  createdBy: number | null;
  /** المُعتمِد/الرافض (للسياق داخل الجسم). */
  actorUserId: number;
  /** سببُ الرفض إن وُجد. */
  reason?: string | null;
  occurredAt: Date;
}

function humanDirection(direction: VoucherDirection): string {
  return direction === "IN" ? "قبض" : "صرف";
}

/**
 * IQD بلا كسور — السندات مُخزَّنة بمنزلتين لكن العملة العراقيّة عمليّاً بلا فلس. نتّبع
 * نمط `apRemindersService.ts` (`toLocaleString("ar-IQ-u-nu-latn")`) للحفاظ على أرقامٍ
 * لاتينيّةٍ افتراضيّةً في كامل النظام (قرار المالك ٢٥/٨ — راجع `check:locale-numbers`).
 */
function formatAmountIqd(amount: string): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return `${amount} د.ع`;
  return `${n.toLocaleString("ar-IQ-u-nu-latn")} د.ع`;
}

function computeEventKey(
  receiptId: number,
  scope: string,
  recipientId: number,
): string {
  const raw = `approval:${scope}:${receiptId}:${recipientId}`;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 40);
}

async function listApprovers(excludeUserId: number | null): Promise<number[]> {
  const db = requireDb();
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.isActive, true),
        // المُعتمِد لا بدّ أن يكون isOwner (approveVoucher line 481 يفرضه).
        eq(users.isOwner, true),
        // حسابٌ منتهي الصلاحية لا يقدر يعتمد أصلاً — لا معنى لإشعاره.
        sql`(${users.accessExpiresAt} IS NULL OR ${users.accessExpiresAt} > NOW())`,
      ),
    );
  const exclude = excludeUserId ?? -1;
  return rows.map((r) => Number(r.id)).filter((id) => id !== exclude);
}

/**
 * يُخطر المالكين النشطين بسندٍ جديدٍ ينتظر اعتمادَهم. **fail-open**: أي عطلٍ يُلتَقَط
 * ويُهمَل — لا يوقف إنشاء السند.
 */
export async function notifyApprovalPending(
  input: ApprovalPendingInput,
): Promise<void> {
  try {
    const recipients = await listApprovers(input.createdBy);
    if (recipients.length === 0) return;
    const kindLabel = humanDirection(input.direction);
    const title = `اعتماد ${kindLabel} #${input.voucherNumber} بانتظارك`;
    const body = `سند ${kindLabel} بمبلغ ${formatAmountIqd(input.amount)} — بانتظار اعتماد مالك.`;
    const route = "/mobile#approvals";
    await Promise.allSettled(
      recipients.map((recipientId) =>
        createAppNotification({
          userId: recipientId,
          kind: "APPROVAL_REQUIRED",
          title,
          body,
          route,
          eventKey: computeEventKey(input.receiptId, "pending", recipientId),
          entityType: "receipt",
          entityId: input.receiptId,
          requiresAction: true,
          // مالٌ ورقمُ سند ⇒ لا يُعرض على شاشة القفل (يُعرض داخل التطبيق فقط).
          lockScreenSafe: false,
        }),
      ),
    );
  } catch {
    // fail-open: قناة إفصاحٍ لا تُعطّل مسار الإنشاء.
  }
}

/**
 * يُخطر مُنشئَ السند بنتيجة الاعتماد/الرفض. **fail-open**.
 *
 * ملاحظة: عند `replayed=true` في `approveVoucher`، الاستدعاءُ آمن لأنّ eventKey ثابت
 * (نفس receiptId + نفس decision + نفس recipient) ⇒ createAppNotification يعيد
 * `created:false` بلا إنشاءٍ مكرَّر. لكن الأفضلُ ألّا يستدعيه الراوتر عند replayed تجنّباً
 * لضربة قاعدةٍ عديمة الأثر.
 */
export async function notifyApprovalDecision(
  input: ApprovalDecisionInput,
): Promise<void> {
  try {
    if (input.createdBy == null) return;
    // لا نُخطر المُعتمِدَ إن كان هو المُنشئ (لن يقع فعلياً لأنّ SOD يرفضه، لكنّه حرسٌ دفاعيّ).
    if (input.createdBy === input.actorUserId) return;
    const kindLabel = humanDirection(input.direction);
    const statusLabel =
      input.decision === "APPROVED" ? "اعتُمد" : "رُفض";
    const title = `${statusLabel} ${kindLabel} #${input.voucherNumber}`;
    const reasonPart =
      input.decision === "REJECTED" && input.reason
        ? ` — السبب: ${input.reason.trim().slice(0, 200)}`
        : "";
    const body = `سند ${kindLabel} بمبلغ ${formatAmountIqd(input.amount)} ${statusLabel}${reasonPart}.`;
    const route = "/mobile#approvals";
    await createAppNotification({
      userId: input.createdBy,
      kind: "APPROVAL_REQUIRED",
      title,
      body,
      route,
      eventKey: computeEventKey(
        input.receiptId,
        `decision:${input.decision}`,
        input.createdBy,
      ),
      entityType: "receipt",
      entityId: input.receiptId,
      // القرارُ إفصاحٌ نهائيّ — لا يطلب فعلاً من المستقبِل.
      requiresAction: false,
      lockScreenSafe: false,
    });
  } catch {
    // fail-open.
  }
}
