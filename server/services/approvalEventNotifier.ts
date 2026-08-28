import crypto from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { receipts, users } from "../../drizzle/schema";
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
 *   4) fail-open: كلّ نقطةِ استدعاءٍ تُغلّف الاستدعاء بـtry/catch — فشلُ الإشعار
 *      لا يُعطّل الاعتماد ولا الإنشاء (المسار المالي لا يعتمد على قناة الإفصاح).
 *   5) الحمولةُ ماليّة (مبلغ + رقم سند) ⇒ `lockScreenSafe:false` (الأثر الحقيقيّ يُطبَّق
 *      داخل `nativePayloadFor` بشمل `APPROVAL_REQUIRED` في قائمة الحسّاسين — Codex P1 ٢٨/٨).
 *
 * ملكيّة الاستعلام (Codex P1 ٢٨/٨): الراوتر يمرّر receiptId فقط — كلّ SELECT وتشكيلُ
 * حمولةِ الإشعار داخل هذه الخدمة حصراً (طبقة `services/` تملك الاستعلامات، طبقة
 * `routers/` تملك zod + بوّابات الصلاحية). راجع AGENTS.md §٢ (قاعدة الطبقات).
 */

export type ApprovalDecision = "APPROVED" | "REJECTED";

/** المسار الويب للاعتماد — `/my-work` تستهلك `superApp.approvalInbox` (App.tsx:419). */
const WEB_APPROVAL_ROUTE = "/my-work";

function humanDirection(direction: "IN" | "OUT"): string {
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

interface ReceiptProjection {
  createdBy: number | null;
  direction: "IN" | "OUT";
  amount: string;
  voucherNumber: string | null;
  approvalStatus: string;
}

async function loadReceiptProjection(
  receiptId: number,
): Promise<ReceiptProjection | null> {
  const db = requireDb();
  const [row] = await db
    .select({
      createdBy: receipts.createdBy,
      direction: receipts.direction,
      amount: receipts.amount,
      voucherNumber: receipts.voucherNumber,
      approvalStatus: receipts.approvalStatus,
    })
    .from(receipts)
    .where(eq(receipts.id, receiptId))
    .limit(1);
  if (!row) return null;
  return {
    createdBy: row.createdBy != null ? Number(row.createdBy) : null,
    direction: (row.direction as "IN" | "OUT") ?? "IN",
    amount: String(row.amount ?? "0"),
    voucherNumber: row.voucherNumber ?? null,
    approvalStatus: String(row.approvalStatus ?? ""),
  };
}

/**
 * يُخطر المالكين النشطين بسندٍ جديدٍ ينتظر اعتمادَهم. **fail-open**.
 *
 * Codex P2 ٢٨/٨: الدالّة تُدعى بـreceiptId فقط — تقرأ الحمولةَ بنفسها من قاعدةِ البيانات.
 * هذا يسمح **لكل** المسارات المولِّدة لسندٍ PENDING_APPROVAL (voucherRouter.create،
 * consignmentSettlement، createSystemPaymentRequestTx عبر assets/walletOps/exchange/…)
 * أن تستدعيها بأمر واحد بعد commit المعاملة، دون تكرار قراءة الحقول في كلّ مستدعٍ.
 */
export async function notifyApprovalPendingByReceipt(
  receiptId: number,
  occurredAt: Date = new Date(),
): Promise<void> {
  try {
    const projection = await loadReceiptProjection(receiptId);
    if (!projection) return;
    // لا نُخطر إلّا سندَ الاعتماد الفعليّ — إن كان APPROVED مباشرة (تحت العتبة) فلا حاجة.
    if (projection.approvalStatus !== "PENDING_APPROVAL") return;
    if (!projection.voucherNumber) return;
    const recipients = await listApprovers(projection.createdBy);
    if (recipients.length === 0) return;
    const kindLabel = humanDirection(projection.direction);
    const title = `اعتماد ${kindLabel} #${projection.voucherNumber} بانتظارك`;
    const body = `سند ${kindLabel} بمبلغ ${formatAmountIqd(projection.amount)} — بانتظار اعتماد مالك.`;
    // مُلاحظة زمنيّة: `occurredAt` لا يدخل حالياً في eventKey ⇒ إعادةُ الاستدعاء لنفس
    // (receiptId, recipientId) مسموحة idempotency-wise. يُبقى المعامل لسياقٍ لاحقٍ إن لزم.
    void occurredAt;
    await Promise.allSettled(
      recipients.map((recipientId) =>
        createAppNotification({
          userId: recipientId,
          kind: "APPROVAL_REQUIRED",
          title,
          body,
          route: WEB_APPROVAL_ROUTE,
          eventKey: computeEventKey(receiptId, "pending", recipientId),
          entityType: "receipt",
          entityId: receiptId,
          requiresAction: true,
          // مالٌ ورقمُ سند ⇒ لا يُعرض على شاشة القفل (nativePayloadFor يتولّى ذلك).
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
 * Codex P1 ٢٨/٨: الراوتر يمرّر receiptId + decision + actorUserId + reason — والخدمة
 * تقرأ (createdBy, direction, amount, voucherNumber) بنفسها. لا SELECT في الراوتر.
 *
 * ملاحظة: عند `replayed=true` في `approveVoucher`، الاستدعاءُ آمن لأنّ eventKey ثابت
 * (نفس receiptId + نفس decision + نفس recipient) ⇒ createAppNotification يعيد
 * `created:false` بلا إنشاءٍ مكرَّر. لكن الأفضلُ ألّا يستدعيه الراوتر عند replayed تجنّباً
 * لضربة قاعدةٍ عديمة الأثر.
 */
export async function notifyApprovalDecisionByReceipt(
  receiptId: number,
  decision: ApprovalDecision,
  actorUserId: number,
  reason?: string | null,
  occurredAt: Date = new Date(),
): Promise<void> {
  try {
    const projection = await loadReceiptProjection(receiptId);
    if (!projection) return;
    if (projection.createdBy == null) return;
    // لا نُخطر المُعتمِدَ إن كان هو المُنشئ (لن يقع فعلياً لأنّ SOD يرفضه، لكنّه حرسٌ دفاعيّ).
    if (projection.createdBy === actorUserId) return;
    if (!projection.voucherNumber) return;
    const kindLabel = humanDirection(projection.direction);
    const statusLabel = decision === "APPROVED" ? "اعتُمد" : "رُفض";
    const title = `${statusLabel} ${kindLabel} #${projection.voucherNumber}`;
    const reasonPart =
      decision === "REJECTED" && reason
        ? ` — السبب: ${reason.trim().slice(0, 200)}`
        : "";
    const body = `سند ${kindLabel} بمبلغ ${formatAmountIqd(projection.amount)} ${statusLabel}${reasonPart}.`;
    void occurredAt;
    await createAppNotification({
      userId: projection.createdBy,
      kind: "APPROVAL_REQUIRED",
      title,
      body,
      route: WEB_APPROVAL_ROUTE,
      eventKey: computeEventKey(
        receiptId,
        `decision:${decision}`,
        projection.createdBy,
      ),
      entityType: "receipt",
      entityId: receiptId,
      // القرارُ إفصاحٌ نهائيّ — لا يطلب فعلاً من المستقبِل.
      requiresAction: false,
      lockScreenSafe: false,
    });
  } catch {
    // fail-open.
  }
}
