/**
 * حدثُ تدقيق **تنفيذ** المرتجع المحكوم — مسارٌ خدميّ واحد لكلّ من يعتمد طلبَ تحكّمٍ بالبيع.
 *
 * ## لماذا وُجد هذا الملف
 *
 * كان الراوتر (`salesControl.approve`) وحده يكتب `RETURN_EXECUTED_AUDIT_ACTION` بعد
 * `approveSalesControlRequest`، ورقيبُ الشذوذ D3-ب (`reports/anomalyWatch.ts`) يعدّ معالجي
 * الإرجاع من هذا الحدث **حصراً**. حين صار الاعتماد ممكناً من صندوق «مطلوب مني الآن»
 * (`decisions.decide` ⇐ `salesControlSource.decide`) كان المسار الثاني يستدعي الخدمة مباشرةً
 * ويتخطّى الكتابة ⇒ مرتجعٌ خرجت به بضاعةٌ ومال **لا يراه الرقيب** (Codex على #1004).
 *
 * الكاتبان يستدعيان هذه الدالّة نفسها؛ لا نسخةَ ثانية تنجرف.
 */
import { logAudit } from "../auditService";
import { RETURN_EXECUTED_AUDIT_ACTION, type ReturnExecutionMode } from "../returns/auditActions";
import type { SalesControlCashRouting, approveSalesControlRequest } from "./controlRequests";

export type SalesControlApprovalResult = Awaited<ReturnType<typeof approveSalesControlRequest>>;
/** ما يقبله `logAudit`: سياقُ الطلب `{ user, req }` أو بياناتٌ محايدة `{ userId, branchId, … }`. */
export type SalesControlAuditSource = Parameters<typeof logAudit>[0];

/**
 * يكتب حدثَ التنفيذ لاعتماد **مرتجعٍ** محكومٍ وقع أثرُه فعلاً. يُرجع `true` إن كُتب.
 *
 *  · غيرُ المرتجع (إلغاء/استبدال/استحقاق) لا يُكتَب هنا — للتدقيق التلقائيّ فعلُه العامّ.
 *  · `replayed` = اعتمادٌ سابقٌ أُعيد تشغيله بلا أثرٍ ثانٍ ⇒ لا حدثَ ثانٍ، وإلّا تضخّم عدّادُ
 *    الرقيب بإعادة محاولةٍ شبكية.
 */
export async function recordGovernedReturnExecution(
  source: SalesControlAuditSource,
  args: { requestId: number; result: SalesControlApprovalResult; cashRouting: SalesControlCashRouting | null },
): Promise<boolean> {
  const { result } = args;
  if ("replayed" in result && result.replayed === true) return false;
  if (!("request" in result) || result.request?.requestType !== "SALES_RETURN") return false;
  return logAudit(source, {
    action: RETURN_EXECUTED_AUDIT_ACTION,
    entityType: "invoice",
    entityId: Number(result.request.invoiceId),
    newValue: {
      mode: "GOVERNED_APPROVAL" satisfies ReturnExecutionMode,
      requestId: args.requestId,
      requestedBy: Number(result.request.requestedBy),
      reason: result.request.reason,
      cashRouting: args.cashRouting,
    },
  });
}
