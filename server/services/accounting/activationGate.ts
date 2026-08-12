import { eq } from "drizzle-orm";
import { doubleEntrySettings } from "../../../drizzle/schema";
import { getDb, type Tx } from "../../db";
import { reconcileDoubleEntryShadowWindow } from "../reconcileService";
import { MAPPED_ENTRY_TYPES } from "./postingEngine";
import type { EntryType } from "../ledgerService";

export const REQUIRED_SHADOW_DAYS = 30;
export const REQUIRED_MAPPED_ENTRY_TYPE_COUNT = 31;
const DAY_MS = 86_400_000;

/** الأنواع الـ31 التي نصّت عليها الخطة والمالك صراحةً (قبل إضافة DELIVERY_FEE_HELD لاحقاً). */
export const PLANNED_ENTRY_TYPES = [
  "SALE", "PURCHASE", "PAYMENT_IN", "PAYMENT_OUT", "RETURN", "ADJUST", "OPENING",
  "INTERNAL_USE", "WASTAGE", "CASH_HANDOVER", "CASH_TRANSFER_OUT", "CASH_TRANSFER_IN",
  "SHIFT_FLOAT_OUT", "TREASURY_FUNDING", "DELIVERY_DISPATCH", "DELIVERY_REMIT", "DELIVERY_FEE",
  "DELIVERY_WRITEOFF", "EXCHANGE_DEPOSIT", "EXCHANGE_WITHDRAW", "EXCHANGE_FX_BUY",
  "EXCHANGE_SETTLE", "EXCHANGE_FEE", "EXCHANGE_FX_DIFF", "GIFT_OUT", "DIGITAL_WALLET_DEPOSIT",
  "DIGITAL_WALLET_WITHDRAWAL", "DIGITAL_WALLET_CONSUMPTION", "DIGITAL_WALLET_REVERSAL",
  "DIGITAL_WALLET_ADJUSTMENT", "DIGITAL_WRITEOFF",
] as const satisfies readonly EntryType[];

/**
 * حارس اكتمال مستقلّ عن العدد: أُضيف DELIVERY_FEE_HELD بعد اعتماد «31/31». لو فحصنا الحجم فقط
 * لمرّت الخرائط القديمة 31/31 وهي تترك هذا المال المحتجَز بلا خريطة. Record<EntryType,…> يجعل
 * TypeScript يرفض أيضاً أي نوعٍ جديدٍ مستقبلاً حتى يُضاف هنا وتراه البوابة.
 */
const CURRENT_ENTRY_TYPE_FLAGS: Record<EntryType, true> = {
  SALE: true,
  PURCHASE: true,
  PAYMENT_IN: true,
  PAYMENT_OUT: true,
  RETURN: true,
  ADJUST: true,
  OPENING: true,
  INTERNAL_USE: true,
  WASTAGE: true,
  CASH_HANDOVER: true,
  CASH_TRANSFER_OUT: true,
  CASH_TRANSFER_IN: true,
  SHIFT_FLOAT_OUT: true,
  TREASURY_FUNDING: true,
  DELIVERY_DISPATCH: true,
  DELIVERY_REMIT: true,
  DELIVERY_FEE: true,
  DELIVERY_FEE_HELD: true,
  DELIVERY_WRITEOFF: true,
  EXCHANGE_DEPOSIT: true,
  EXCHANGE_WITHDRAW: true,
  EXCHANGE_FX_BUY: true,
  EXCHANGE_SETTLE: true,
  EXCHANGE_FEE: true,
  EXCHANGE_FX_DIFF: true,
  GIFT_OUT: true,
  DIGITAL_WALLET_DEPOSIT: true,
  DIGITAL_WALLET_WITHDRAWAL: true,
  DIGITAL_WALLET_CONSUMPTION: true,
  DIGITAL_WALLET_REVERSAL: true,
  DIGITAL_WALLET_ADJUSTMENT: true,
  DIGITAL_WRITEOFF: true,
};
export const CURRENT_ENTRY_TYPES = Object.keys(CURRENT_ENTRY_TYPE_FLAGS) as EntryType[];

export type ActivationBlockerKey =
  | "MODE"
  | "SHADOW_START"
  | "SHADOW_DURATION"
  | "MAPPING_COVERAGE"
  | "UNMAPPED_GAPS"
  | "MISSING_JOURNALS"
  | "EXTRA_JOURNALS"
  | "JOURNAL_SCOPE_MISMATCH"
  | "SOURCE_MAPPING"
  | "RECONCILIATION_DRIFT"
  | "JOURNAL_IMBALANCE";

export interface ActivationBlocker {
  key: ActivationBlockerKey;
  label: string;
  detail: string;
  actual: string | number | null;
  required: string | number;
}

export interface ActivationGateResult {
  ok: boolean;
  mode: "OFF" | "SHADOW" | "ACTIVE";
  shadowStartedAt: string | null;
  shadowDays: number;
  requiredShadowDays: number;
  mappedTypes: number;
  requiredMappedTypes: number;
  unmappedEntryTypes: string[];
  gapCount: number;
  missingCount: number;
  extraCount: number;
  scopeMismatchCount: number;
  unreconstructableCount: number;
  drift: string;
  journalImbalance: string;
  blockers: ActivationBlocker[];
}

function blocker(
  key: ActivationBlockerKey,
  label: string,
  actual: string | number | null,
  required: string | number,
  detail: string,
): ActivationBlocker {
  return { key, label, actual, required, detail };
}

/** بوابة ACTIVE الوحيدة: قرارها مشتقٌ من قاعدة البيانات، ولا تقبل أيّ ادّعاءٍ من الواجهة. */
export async function canActivate(options?: { tx?: Tx; now?: Date }): Promise<ActivationGateResult> {
  const executor = options?.tx ?? getDb();
  const now = options?.now ?? new Date();
  const row = executor
    ? (await executor
        .select({ mode: doubleEntrySettings.mode, shadowStartedAt: doubleEntrySettings.shadowStartedAt })
        .from(doubleEntrySettings)
        .where(eq(doubleEntrySettings.id, 1))
        .limit(1))[0]
    : undefined;
  const mode = row?.mode ?? "OFF";
  const startedAt = row?.shadowStartedAt ?? null;
  const elapsedMs = startedAt ? Math.max(0, now.getTime() - startedAt.getTime()) : 0;
  const shadowDays = Math.floor(elapsedMs / DAY_MS);
  const reconciliation = startedAt
    ? await reconcileDoubleEntryShadowWindow({ from: startedAt, to: now }, { tx: options?.tx })
    : null;
  const mappedTypes = PLANNED_ENTRY_TYPES.filter((entryType) => MAPPED_ENTRY_TYPES.has(entryType)).length;
  const unmappedEntryTypes = CURRENT_ENTRY_TYPES.filter((entryType) => !MAPPED_ENTRY_TYPES.has(entryType));
  const blockers: ActivationBlocker[] = [];

  if (mode !== "SHADOW") {
    blockers.push(blocker("MODE", "وضع الدفتر", mode, "SHADOW", "لا يبدأ ACTIVE إلا من وضع الظل."));
  }
  if (!startedAt) {
    blockers.push(blocker("SHADOW_START", "بداية الظل", null, "تاريخ موجود", "لم يُسجَّل وقت بدء المراقبة الظليّة."));
  } else if (elapsedMs < REQUIRED_SHADOW_DAYS * DAY_MS) {
    blockers.push(blocker(
      "SHADOW_DURATION",
      "مدة الظل",
      shadowDays,
      REQUIRED_SHADOW_DAYS,
      `اكتمل ${shadowDays} من ${REQUIRED_SHADOW_DAYS} يوماً مطلوباً.`,
    ));
  }
  if (mappedTypes !== REQUIRED_MAPPED_ENTRY_TYPE_COUNT || unmappedEntryTypes.length > 0) {
    blockers.push(blocker(
      "MAPPING_COVERAGE",
      "تغطية خرائط القيود",
      mappedTypes,
      REQUIRED_MAPPED_ENTRY_TYPE_COUNT,
      `خرائط الخطة ${mappedTypes}/${REQUIRED_MAPPED_ENTRY_TYPE_COUNT}`
        + (unmappedEntryTypes.length > 0 ? `؛ الأنواع الحالية غير المغطّاة: ${unmappedEntryTypes.join("، ")}.` : "."),
    ));
  }
  if (reconciliation) {
    if (reconciliation.gapCount > 0) {
      blockers.push(blocker("UNMAPPED_GAPS", "فجوات الظل", reconciliation.gapCount, 0, "توجد أحداث مالية مسجّلة كفجوات."));
    }
    if (reconciliation.missingCount > 0) {
      blockers.push(blocker("MISSING_JOURNALS", "قيود يومية مفقودة", reconciliation.missingCount, 0, "توجد أحداث في الدفتر المبسّط بلا رأس يومية مزدوجة."));
    }
    if (reconciliation.extraCount > 0) {
      blockers.push(blocker("EXTRA_JOURNALS", "قيود يومية زائدة", reconciliation.extraCount, 0, "توجد رؤوس يومية خارج أحداث نافذة الظل."));
    }
    if (reconciliation.scopeMismatchCount > 0) {
      blockers.push(blocker(
        "JOURNAL_SCOPE_MISMATCH",
        "نطاق يومية غير مطابق",
        reconciliation.scopeMismatchCount,
        0,
        "يوجد رأس يومية منسوب إلى فرع أو تاريخ قيد مختلف عن حدثه المصدر.",
      ));
    }
    if (reconciliation.unreconstructableCount > 0) {
      blockers.push(blocker("SOURCE_MAPPING", "أحداث غير قابلة لإعادة المطابقة", reconciliation.unreconstructableCount, 0, "تعذّر اشتقاق الخريطة المتوقعة لبعض الأحداث."));
    }
    if (reconciliation.drift !== "0.00") {
      blockers.push(blocker("RECONCILIATION_DRIFT", "انحراف المطابقة", reconciliation.drift, "0.00", "صافي دورٍ محاسبيّ واحدٍ على الأقل لا يطابق مصدره."));
    }
    if (reconciliation.journalImbalance !== "0.00") {
      blockers.push(blocker("JOURNAL_IMBALANCE", "توازن اليومية", reconciliation.journalImbalance, "0.00", "مجموع المدين لا يساوي مجموع الدائن داخل النافذة."));
    }
  }

  return {
    ok: blockers.length === 0,
    mode,
    shadowStartedAt: startedAt?.toISOString() ?? null,
    shadowDays,
    requiredShadowDays: REQUIRED_SHADOW_DAYS,
    mappedTypes,
    requiredMappedTypes: REQUIRED_MAPPED_ENTRY_TYPE_COUNT,
    unmappedEntryTypes,
    gapCount: reconciliation?.gapCount ?? 0,
    missingCount: reconciliation?.missingCount ?? 0,
    extraCount: reconciliation?.extraCount ?? 0,
    scopeMismatchCount: reconciliation?.scopeMismatchCount ?? 0,
    unreconstructableCount: reconciliation?.unreconstructableCount ?? 0,
    drift: reconciliation?.drift ?? "0.00",
    journalImbalance: reconciliation?.journalImbalance ?? "0.00",
    blockers,
  };
}
