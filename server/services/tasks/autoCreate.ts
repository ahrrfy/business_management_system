// إنشاء تلقائي للمهمة من رسالة واتساب واردة — hook مركز واتساب الأعمال (waHubSettings.triageMode).
// يُستدعى من server/services/whatsapp/webhookProcessor.ts بعد إدراج رسالة IN أولى (غير مُكرَّرة)
// وتحديث lastInboundAt — نفس المعاملة إن أمكن (يقبل tx خارجية كـcreateTask).
import { and, asc, eq, isNull, notInArray, or } from "drizzle-orm";
import { tasks, waHubSettings, waKeywordRules } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { createTask, type TaskKind, type TaskSourceChannel } from "./create";

const CLOSED_STATUSES = ["RESOLVED", "CANCELLED"] as const;
const AUTO_CREATE_TITLE_MAX = 80;

export interface MaybeCreateTaskForInboundInput {
  conversationId: number;
  branchId: number;
  customerId?: number | null;
  messageBody: string;
  sourceChannel: TaskSourceChannel;
}

/**
 * تُنشئ مهمة تلقائياً من رسالة IN واردة — إن كان وضع الفرز فعّالاً وبلا مهمة مفتوحة أصلاً لنفس
 * المحادثة (مهمة واحدة مفتوحة لكل محادثة). لا ترمي أبداً على حالات «لا شيء لفعله» (بلا إعدادات/
 * وضع يدوي/بلا مطابقة KEYWORD_ONLY) — تعيد `{created:false}` بهدوء؛ المستدعي (webhookProcessor)
 * يبقى مسؤولاً عن لفّها بـtry/catch لئلا يُفشل استقبال رسالة واتساب فعلية.
 */
export async function maybeCreateTaskForInbound(
  tx: Tx,
  input: MaybeCreateTaskForInboundInput,
): Promise<{ created: boolean; taskId?: number }> {
  const settings = (await tx.select().from(waHubSettings).where(eq(waHubSettings.id, 1)).limit(1))[0];
  if (!settings || !settings.autoTaskEnabled || settings.triageMode === "MANUAL") {
    return { created: false };
  }

  // مهمة واحدة مفتوحة لكل محادثة — إعادة فتح بعد إغلاق (RESOLVED/CANCELLED) مقصودة (لا استثناء لها هنا).
  const openExisting = (
    await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.conversationId, input.conversationId), notInArray(tasks.taskStatus, [...CLOSED_STATUSES])))
      .limit(1)
  )[0];
  if (openExisting) return { created: false };

  // تصنيف بكلمة مفتاحية — عامة (branchId IS NULL) أو خاصة بالفرع، بترتيب priority تصاعدياً
  // (الأصغر يُطبَّق أولاً). مطابقة "يحوي" بسيطة حتمية بحدّ أدنى من التطبيع (حالة الأحرف).
  const rules = await tx
    .select()
    .from(waKeywordRules)
    .where(and(eq(waKeywordRules.isActive, true), or(isNull(waKeywordRules.branchId), eq(waKeywordRules.branchId, input.branchId))))
    .orderBy(asc(waKeywordRules.priority));

  const body = input.messageBody ?? "";
  const normalizedBody = body.trim().toLowerCase();
  const matchedRule = rules.find((r) => {
    const pat = r.pattern?.trim().toLowerCase();
    return !!pat && normalizedBody.includes(pat);
  });

  let kind: TaskKind;
  let serviceTypeId: number | null = null;
  if (matchedRule) {
    kind = matchedRule.matchKind as TaskKind;
    serviceTypeId = matchedRule.serviceTypeId != null ? Number(matchedRule.serviceTypeId) : null;
  } else if (settings.triageMode === "AUTO_ALL") {
    kind = "INQUIRY";
  } else {
    // KEYWORD_ONLY بلا مطابقة ⇒ لا تُنشئ مهمة (تفاعلٌ بلا فرز — الموظف يفتحها يدوياً لو لزم).
    return { created: false };
  }

  const trimmedBody = body.trim();
  const title = trimmedBody ? trimmedBody.slice(0, AUTO_CREATE_TITLE_MAX) : "استفسار واتساب";

  const res = await createTask(
    {
      branchId: input.branchId,
      kind,
      title,
      customerId: input.customerId ?? null,
      conversationId: input.conversationId,
      serviceTypeId,
      sourceChannel: input.sourceChannel,
      creationNote: "أُنشئت تلقائياً من محادثة",
    },
    { userId: null, branchId: input.branchId },
    tx,
  );
  return { created: true, taskId: res.taskId };
}
