/**
 * الحارس المشترك للأتمتة الخلفية (T4.2) — نقطة التطبيق الوحيدة لتدفّقات الإشعار الآلي القائمة على
 * قالب Meta (تذكيرات AR/AP عبر API، طلب جاهز، شكر الشراء، سحب بضاعة الأمانة) + بوّابة مشتركة يُعاد
 * استعمالها من الردّ الآلي (بعد الدوام/الترحيب) وCSAT.
 *
 * **القاعدة الذهبية (مُلزِمة، راجع CLAUDE.md §٦):** الأتمتة لا تُفشِل أي عملية أعمال أبداً.
 * `flowNotify` **لا يرمي مطلقاً** — كل خطأ يُبتلع ويُسجَّل pino warn، وكل مستدعٍ يبقى على مساره
 * الحالي (wa.me اليدوي/بلا إشعار) دون أي أثر عند إيقاف المفتاح أو غياب تكامل نشط أو فشل غير متوقّع.
 *
 * تسلسل بوّابات `flowNotify` (بالترتيب — أول رفض يُنهي فوراً):
 *   1. لا رقم هاتف صالح ⇒ توقّف (لا معنى للمتابعة).
 *   2. killSwitch عام (waHubSettings) ⇒ توقّف كل إرسال آلي.
 *   3. مفتاح التدفّق (flowKey) غير مفعّل ⇒ توقّف (كل المفاتيح OFF افتراضياً — صفر أثر رجعي).
 *   4. لا تكامل واتساب ACTIVE لهذا الفرع ⇒ توقّف (المستدعي يبقى على مساره الحالي دون تغيير).
 *   5. customerId مُمرَّر وwaConsent='OPTED_OUT' ⇒ توقّف دائماً — لا استثناء لهذه القاعدة.
 *   6. القالب غير APPROVED عند Meta بعد (لم يُعتمَد/لم يُزامَن) ⇒ توقّف بأمان (لا رمي — يُعتمَد لاحقاً).
 *   7. `enqueueAndDispatch` بـkind=TEMPLATE + dedupeKey ⇒ idempotent (استدعاء مكرَّر بنفس dedupeKey
 *      يعيد نفس الصفّ بلا ازدواج).
 */
import { eq } from "drizzle-orm";
import { customers, waHubSettings, type WaHubSettings } from "../../../drizzle/schema";
import { logger } from "../../logger";
import { requireDb } from "../tx";
import { enqueueAndDispatch, getActiveWaIntegration, type ActiveWaIntegration } from "./outboxService";
import { getUsableTemplate } from "./templateService";

/** مفاتيح تدفّقات الإشعار بقالب (§ب في المواصفة) — كلٌّ عمود Boolean مستقلّ في waHubSettings. */
export type AutomationFlowKey =
  | "flowArReminder"
  | "flowOrderReady"
  | "flowPurchaseThanks"
  | "flowConsignmentWithdraw";

/** كل مفاتيح الأتمتة القابلة للبوّابة المشتركة (تدفّقات القوالب + الردّ الآلي + CSAT). */
export type AutomationFlagKey = AutomationFlowKey | "csatOnResolve" | "autoReplyAfterHours" | "autoReplyWelcome";

export interface FlowNotifyInput {
  flowKey: AutomationFlowKey;
  branchId: number;
  toPhoneE164: string | null | undefined;
  /** مُمرَّر ⇒ يُحترَم OPTED_OUT دائماً (§المبدأ الحاكم). التدفّقات الخدمية (Utility) لا تحتاج opt-in صريح. */
  customerId?: number | null;
  templateName: string;
  /** افتراضياً "ar" — كل قوالبنا عربية. */
  templateLang?: string;
  bodyParams: string[];
  dedupeKey: string;
}

export type FlowNotifySkipReason =
  | "kill_switch"
  | "disabled"
  | "no_integration"
  | "no_phone"
  | "opted_out"
  | "template_unavailable"
  | "error";

export type FlowNotifyResult = { queued: true; outboxId: number; isNew: boolean } | { skipped: FlowNotifySkipReason };

// ── إعدادات مركز واتساب الأعمال (get-or-default) ──────────────────────────────────────────────

/** افتراضيات مطابقة لِـ`.default(...)` في `drizzle/schema.ts` حرفياً — نمط `WA_HUB_DEFAULTS` في
 *  integrationRouter.ts (خاصّ به، غير مُصدَّر). صفّ singleton id=1 يبذره seed.ts عادةً؛ غيابه (سباق
 *  نادر قبل أوّل seed، أو بيئة اختبار بلا seed) لا يعني السماح — كل مفاتيح الأتمتة تبقى OFF. */
const FLAG_DEFAULTS: Record<AutomationFlagKey, false> = {
  flowArReminder: false,
  flowOrderReady: false,
  flowPurchaseThanks: false,
  flowConsignmentWithdraw: false,
  csatOnResolve: false,
  autoReplyAfterHours: false,
  autoReplyWelcome: false,
};

function defaultWaHubSettings(): WaHubSettings {
  return {
    id: 1,
    triageMode: "AUTO_ALL",
    autoTaskEnabled: true,
    businessHoursJson: null,
    afterHoursReply: null,
    welcomeReply: null,
    throttlePerMinute: 10,
    optOutKeywords: null,
    campaignApprovalThreshold: 500,
    ...FLAG_DEFAULTS,
    killSwitch: false,
    updatedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as WaHubSettings;
}

/** get-or-default لصفّ waHubSettings(id=1) — لا كتابة أبداً (نمط openingModeService.getOpeningMode). */
export async function getWaHubSettings(): Promise<WaHubSettings> {
  const db = requireDb();
  const row = (await db.select().from(waHubSettings).where(eq(waHubSettings.id, 1)).limit(1))[0];
  return row ?? defaultWaHubSettings();
}

// ── البوّابة المشتركة (خطوات ٢-٤) ───────────────────────────────────────────────────────────────

export type AutomationGateResult =
  | { ok: true; integration: ActiveWaIntegration; settings: WaHubSettings }
  | { ok: false; skipped: "kill_switch" | "disabled" | "no_integration" };

/** بوّابة الأتمتة المشتركة: killSwitch + مفتاح التدفّق + تكامل واتساب ACTIVE على الفرع. مُعاد
 *  استعمالها من `flowNotify` (تدفّقات القوالب) والردّ الآلي (بعد الدوام/الترحيب) وCSAT — نفس معايير
 *  الإيقاف للجميع، بوّابة واحدة لا نسخ متكرّرة تنجرف مع الوقت. */
export async function checkAutomationGate(flagKey: AutomationFlagKey, branchId: number): Promise<AutomationGateResult> {
  const settings = await getWaHubSettings();
  if (settings.killSwitch) return { ok: false, skipped: "kill_switch" };
  if (!settings[flagKey]) return { ok: false, skipped: "disabled" };
  const integration = await getActiveWaIntegration(branchId);
  if (!integration) return { ok: false, skipped: "no_integration" };
  return { ok: true, integration, settings };
}

async function isCustomerOptedOut(customerId: number): Promise<boolean> {
  const db = requireDb();
  const row = (
    await db.select({ waConsent: customers.waConsent }).from(customers).where(eq(customers.id, customerId)).limit(1)
  )[0];
  return row?.waConsent === "OPTED_OUT";
}

// ── flowNotify — نقطة التطبيق الوحيدة لتدفّقات القوالب (§ب) ────────────────────────────────────

/**
 * يحاول جدولة إشعار آلي بقالب Meta معتمَد — **لا يرمي أبداً**. كل رفض يُعاد كسبب `skipped` واضح
 * (المستدعي لا يحتاج التمييز عادةً؛ الاسترجاع للتشخيص/الاختبار فقط). نجاح ⇒ صفّ TEMPLATE في
 * `waOutbox` (idempotent بـdedupeKey) + محاولة إرسال فورية غير متزامنة (نمط enqueueAndDispatch).
 */
export async function flowNotify(input: FlowNotifyInput): Promise<FlowNotifyResult> {
  try {
    if (!input.toPhoneE164?.trim()) return { skipped: "no_phone" };

    const gate = await checkAutomationGate(input.flowKey, input.branchId);
    if (!gate.ok) return { skipped: gate.skipped };

    if (input.customerId != null && (await isCustomerOptedOut(input.customerId))) {
      return { skipped: "opted_out" };
    }

    const lang = input.templateLang ?? "ar";
    const template = await getUsableTemplate(input.templateName, lang);
    if (!template) return { skipped: "template_unavailable" };

    const res = await enqueueAndDispatch({
      dedupeKey: input.dedupeKey,
      branchId: input.branchId,
      toPhoneE164: input.toPhoneE164,
      kind: "TEMPLATE",
      payloadJson: { bodyParams: input.bodyParams },
      templateName: input.templateName,
      templateLang: lang,
    });
    return { queued: true, outboxId: res.id, isNew: res.isNew };
  } catch (e) {
    logger.warn(
      { err: e instanceof Error ? e.message : String(e), flowKey: input.flowKey, dedupeKey: input.dedupeKey },
      "flowNotify: تعذّر إرسال إشعار آلي — تُجوهل (الأتمتة لا تُفشِل عملية الأعمال أبداً)",
    );
    return { skipped: "error" };
  }
}

// ── ساعات الدوام (§ج في المواصفة) ───────────────────────────────────────────────────────────────

/**
 * بنية `waHubSettings.businessHoursJson` المُتوقَّعة (JSON حرّ — بلا Zod schema على عمود JSON):
 *   `{ days: number[], from: "HH:MM", to: "HH:MM" }`
 * - `days`: أيام الدوام بترميز `Date.getUTCDay()` **بعد الإزاحة لتوقيت بغداد** (0=الأحد..6=السبت).
 * - `from`/`to`: بداية/نهاية الدوام اليومي، صيغة 24 ساعة "HH:MM"، توقيت بغداد (UTC+3 بلا DST —
 *   نفس الإزاحة الثابتة المُستعمَلة في `catalog/pos.ts`/`onlineOrderService.ts`).
 * - نطاق مقلوب/متساوٍ (`from >= to`) يُعامَل كإعداد غير صالح — تحفّظي: لا يُعتبَر خارج الدوام أبداً.
 */
export interface BusinessHoursConfig {
  days: number[];
  from: string;
  to: string;
}

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
/** إزاحة بغداد الثابتة (UTC+3، بلا توقيت صيفي) — نمط `catalog/pos.ts`. */
const BAGHDAD_OFFSET_MS = 3 * 60 * 60 * 1000;

function parseBusinessHours(raw: unknown): BusinessHoursConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const days = Array.isArray(o.days)
    ? (o.days.filter((d): d is number => typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6) as number[])
    : null;
  const from = typeof o.from === "string" && HHMM_RE.test(o.from) ? o.from : null;
  const to = typeof o.to === "string" && HHMM_RE.test(o.to) ? o.to : null;
  if (!days || !days.length || !from || !to) return null;
  return { days, from, to };
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** خارج الدوام؟ بلا إعداد صالح ⇒ تحفّظياً «داخل الدوام» (لا نرسل ردّ «خارج الدوام» بلا سياسة مضبوطة). */
export function isOutsideBusinessHours(raw: unknown, now: Date = new Date()): boolean {
  const cfg = parseBusinessHours(raw);
  if (!cfg) return false;
  const baghdad = new Date(now.getTime() + BAGHDAD_OFFSET_MS);
  const weekday = baghdad.getUTCDay();
  const minutesOfDay = baghdad.getUTCHours() * 60 + baghdad.getUTCMinutes();
  if (!cfg.days.includes(weekday)) return true; // يوم عطلة ⇒ خارج الدوام.
  const from = toMinutes(cfg.from);
  const to = toMinutes(cfg.to);
  if (from >= to) return false; // إعداد غير صالح — تحفّظي.
  return minutesOfDay < from || minutesOfDay >= to;
}

/** حبيبة اليوم المحلي (بغداد) بصيغة YYYYMMDD — لـdedupeKey throttle مرّة/يوم (`AH:{convId}:{yyyymmdd}`). */
export function baghdadYmdCompact(now: Date = new Date()): string {
  const baghdad = new Date(now.getTime() + BAGHDAD_OFFSET_MS);
  const y = baghdad.getUTCFullYear();
  const m = String(baghdad.getUTCMonth() + 1).padStart(2, "0");
  const d = String(baghdad.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}
