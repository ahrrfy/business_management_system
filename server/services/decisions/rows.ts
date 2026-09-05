/**
 * بناءُ صفّ الصندوق — **دوالّ نقيّة** بلا قاعدةٍ ولا `Date.now()`: كلُّ مصدرٍ يمرّر ما قرأه
 * ولحظةَ «الآن»، فتُختبَر المحوِّلات حتميّاً بلا قاعدة (`vitest.unit.config.ts`).
 */
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import {
  DECISION_ACTION_LABEL_AR,
  decisionAgeHours,
  decisionSla,
  decisionSpec,
  type DecisionAction,
  type DecisionDecideResult,
  type DecisionKind,
  type DecisionOutcome,
  type DecisionRowModel,
  type DecisionSummaryItem,
  type DecisionTrigger,
} from "@shared/decisionRegistry";

/** ما يملؤه المصدر؛ الباقي يُشتقّ أو يأخذ افتراضه الصريح. */
export interface RowInput {
  kind: DecisionKind;
  id: number;
  title: string;
  requestedAt: Date | string | null | undefined;
  subkind?: string | null;
  party?: string | null;
  amount?: string | number | null;
  currency?: "IQD" | "USD";
  branchId?: number | null;
  branchName?: string | null;
  requestedBy?: number | null;
  requestedByName?: string | null;
  summaryItems?: DecisionSummaryItem[];
  reason?: string | null;
  allowedActions?: DecisionAction[];
  /** معرّفُ المستند الذي يقبله `href` السجلّ (يختلف عن معرّف الطلب أحياناً). */
  hrefId?: number | string | null;
  expectedVersion?: number | null;
  confirmations?: Array<{ key: string; label: string }>;
  requiredReference?: { key: string; label: string; minLength: number } | null;
  rejectReason?: "REQUIRED" | "OPTIONAL" | "NOT_SUPPORTED";
  approveReason?: "REQUIRED" | "OPTIONAL";
  reasonMinLength?: number;
  approveBlockedReason?: string | null;
  /** صيغُ الاعتماد حين يتعدّد (انظر `DecisionRowModel.approveVariants`). */
  approveVariants?: Array<{ key: string; label: string }>;
  trigger?: DecisionTrigger | null;
}

/** نصٌّ عشريّ نظيف للمبلغ، أو `null`. لا `Number()` على المال — النصّ يمرّ كما هو. */
export function moneyText(v: string | number | null | undefined): string | null {
  if (v == null || v === "") return null;
  const s = typeof v === "number" ? String(v) : v.trim();
  return s.length ? s : null;
}

export function isoOf(d: Date | string | null | undefined): string {
  if (!d) return new Date(0).toISOString();
  const date = typeof d === "string" ? new Date(d) : d;
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

/** يبني الصفّ من مدخل المصدر — يرمي على نوعٍ غير مُسجَّل (صفٌّ لقرارٍ لا وجودَ له). */
export function buildRow(input: RowInput, now: Date): DecisionRowModel {
  const spec = decisionSpec(input.kind);
  if (!spec) throw new Error(`decision kind not registered: ${input.kind}`);
  const requestedAt = isoOf(input.requestedAt);
  const ageHours = decisionAgeHours(requestedAt, now);
  const trigger = input.trigger ?? null;
  return {
    kind: input.kind,
    id: input.id,
    title: input.title,
    subkind: input.subkind ?? null,
    party: input.party?.trim() || null,
    amount: moneyText(input.amount),
    currency: input.currency ?? "IQD",
    branchId: input.branchId ?? null,
    branchName: input.branchName ?? null,
    requestedBy: input.requestedBy ?? null,
    requestedByName: input.requestedByName ?? null,
    requestedAt,
    ageHours,
    sla: decisionSla(ageHours, trigger),
    summaryItems: input.summaryItems ?? [],
    reason: input.reason?.trim() || null,
    allowedActions: input.allowedActions ?? ["APPROVE", "REJECT"],
    href: spec.href(input.hrefId ?? input.id),
    expectedVersion: input.expectedVersion ?? null,
    confirmations: input.confirmations ?? [],
    requiredReference: input.requiredReference ?? null,
    rejectReason: input.rejectReason ?? "REQUIRED",
    approveReason: input.approveReason ?? "OPTIONAL",
    reasonMinLength: input.reasonMinLength ?? 3,
    approveBlockedReason: input.approveBlockedReason ?? null,
    approveVariants: input.approveVariants ?? [],
    trigger,
  };
}

/**
 * ⛔ الفعلُ غيرُ المُعلَن يُرفَض **قبل** بلوغ `source.decide`: أغلبُ المصادر تعامل «غيرَ الرفض»
 * اعتماداً، فـ`REJECT` على نوعٍ لا يدعم الرفض كان ينفّذ الاعتماد ويُدوَّن رفضاً (Codex على #1004).
 * الرسالةُ تسمّي المدعوم وتقود إلى الشاشة الأصلية لما ليس مدعوماً هنا.
 */
export function assertActionSupported(
  source: { supportedActions: readonly DecisionAction[] },
  input: { kind: DecisionKind; id: number; action: DecisionAction },
  subject: string,
): void {
  if (source.supportedActions.includes(input.action)) return;
  const label = DECISION_ACTION_LABEL_AR[input.action];
  const supported = source.supportedActions.map((a) => DECISION_ACTION_LABEL_AR[a]).join(" · ");
  const href = decisionSpec(input.kind)?.href(input.id);
  throw new TRPCError({
    code: "BAD_REQUEST",
    message: appErrorMessage({
      what: `تعذّر ${label} ${subject}`,
      why: `هذا النوع لا يدعم فعل «${label}» من الصندوق — المدعوم هنا: ${supported || "لا شيء"}`,
      doThis: href ? `اختر فعلاً مدعوماً، أو افتح شاشته (${href}) لما عداه` : "اختر فعلاً مدعوماً",
    }),
  });
}

/**
 * يختار صيغةَ الاعتماد من مدخل الحسم حين يعلن الصفُّ صيغاً — ⛔ لا افتراضَ صامتٌ لأولاها:
 * الاعتمادُ بلا اختيارٍ صريح يُرفَض برسالةٍ تسمّي الصيغ. `variants` فارغةٌ ⇒ `null` (اعتمادٌ واحد).
 */
export function pickApproveVariant<K extends string>(
  variants: ReadonlyArray<{ key: K; label: string }>,
  chosen: string | null | undefined,
  subject: string,
): K | null {
  if (!variants.length) return null;
  const hit = variants.find((v) => v.key === chosen);
  if (hit) return hit.key;
  throw new TRPCError({
    code: "BAD_REQUEST",
    message: appErrorMessage({
      what: `تعذّر اعتماد ${subject}`,
      why: chosen
        ? `صيغة الاعتماد «${chosen}» ليست من الصيغ المتاحة لهذا القرار`
        : "لهذا القرار أكثر من نتيجة اعتماد ولم تُختر واحدة منها",
      doThis: `اختر صيغة الاعتماد صراحةً: ${variants.map((v) => v.label).join(" · ")}`,
    }),
  });
}

/** نتيجةُ الحسم من حالةٍ أعادتها الخدمة — لا «نجاح» على `STALE` ولا على `PENDING`. */
export function outcomeFor(action: DecisionAction, status?: string | null): DecisionOutcome {
  const s = (status ?? "").toUpperCase();
  if (s === "STALE") return "STALE";
  if (action === "WITHDRAW") return "WITHDRAWN";
  if (action === "REJECT") return s === "PENDING" ? "STALE" : "REJECTED";
  if (s === "PENDING" || s === "PENDING_APPROVAL") return "REQUESTED";
  return "EXECUTED";
}

/** يستخرج حالةً من نتيجةٍ خدميّةٍ ذات أشكالٍ شتّى (`{status}` · `{request:{status}}`). */
export function statusOf(res: unknown): string | null {
  if (!res || typeof res !== "object") return null;
  const r = res as { status?: unknown; request?: { status?: unknown } };
  if (typeof r.status === "string") return r.status;
  if (r.request && typeof r.request.status === "string") return r.request.status;
  return null;
}

export function decided(
  input: { kind: DecisionKind; id: number; action: DecisionAction },
  outcome: DecisionOutcome,
  message: string,
): DecisionDecideResult {
  return { kind: input.kind, id: input.id, action: input.action, outcome, message };
}

/** رسالةُ نتيجةٍ افتراضية بالعربية — تُستبدَل برسالة الخدمة حين تُرجع واحدة. */
export function defaultMessage(outcome: DecisionOutcome, subject: string): string {
  switch (outcome) {
    case "EXECUTED":
      return `${subject}: اعتُمد ونُفّذ أثرُه.`;
    case "REQUESTED":
      return `${subject}: اعتُمد وأُنشئ طلبٌ ينتظر جهةً أعلى قبل التنفيذ.`;
    case "STALE":
      return `${subject}: لم يعد معلّقاً — حُسم من غيرك أو تغيّر مستنده. أعد تحميل الصندوق.`;
    case "REJECTED":
      return `${subject}: رُفض وسُجّل السبب للطالب.`;
    case "WITHDRAWN":
      return `${subject}: سُحب الطلب.`;
  }
}

/** `decisionKey` للخدمات التي تشترطه: مشتقٌّ من مفتاح النقرة فيُعاد نفسُه عند إعادة المحاولة. */
export function decisionKeyFor(clientRequestId: string): string {
  return `inbox:${clientRequestId}`.slice(0, 120);
}

/** اسمُ صنفٍ للعرض: الاسم + المتغيّر + الوحدة. */
export function itemLabel(parts: Array<string | null | undefined>): string {
  return parts.map((p) => p?.trim()).filter((p): p is string => !!p).join(" · ");
}
