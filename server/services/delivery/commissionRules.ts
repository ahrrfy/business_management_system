/**
 * قواعد عمولة المندوب — CRUD + معاينة (Slice G، ٢٩/٨/٢٦).
 *
 * بلاغ المالك (٢٨/٨/٢٦): «محاسبياً لا تتم التسوية على المندوب والشركة يجب أن يكون كل شيء
 * مؤتمتاً تلقائياً». هذا الملف يُنجز **الطبقة القابلة للقراءة** — قواعدُ العمولة تُدخَل وتُقرَأ
 * ويُحسَب مبلغُها لأيّ إرسالية، لكن **بلا قيدٍ محاسبيّ تلقائيّ بعد**: القيدُ يمسّ ذمّةَ المندوب
 * وحسابَ مصروف العمولة، ويلزمه قرارُ المالك على النموذج (FLAT_PER_DELIVERY الافتراضيّ) قبل تفعيله.
 *
 * كلّ العمليّات محكومةٌ في `withTx` بمنطقٍ بسيط (لا فروع متزامنة). الفهرس `idx_courier_commission_party`
 * يخدم القراءة السريعة عند المعاينة والتسوية اللاحقة.
 */
import { eq, isNull, or } from "drizzle-orm";
import { courierCommissionRules } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { withTx } from "../tx";
import {
  computeCourierCommission,
  type CourierCommissionRuleInput,
  type CommissionQuote,
} from "@shared/courierCommission";

/** أعِد كلّ القواعد الفعّالة لجهةٍ (خاصّتها + العامّة الافتراضية). النشاط + النفاذ الزمني يُصفّى في الحساب. */
export async function listCommissionRulesForParty(tx: Tx, partyId: number) {
  return tx
    .select()
    .from(courierCommissionRules)
    .where(or(eq(courierCommissionRules.partyId, partyId), isNull(courierCommissionRules.partyId)));
}

/** كلّ القواعد (للإدارة العامّة). */
export async function listAllCommissionRules(tx: Tx) {
  return tx.select().from(courierCommissionRules);
}

export interface SaveCommissionRuleInput {
  id?: number | null;
  partyId?: number | null;
  ruleType: "FLAT_PER_DELIVERY" | "PERCENT_OF_FEE" | "PERCENT_OF_ORDER" | "HYBRID";
  flatAmount?: string | null;
  percentValue?: string | null;
  minGuarantee?: string | null;
  maxCap?: string | null;
  isActive?: boolean;
  branchId?: number | null;
  effectiveFrom?: Date | null;
  effectiveTo?: Date | null;
  notes?: string | null;
}

export async function saveCommissionRule(input: SaveCommissionRuleInput) {
  return withTx(async (tx) => {
    const payload = {
      partyId: input.partyId ?? null,
      ruleType: input.ruleType,
      flatAmount: input.flatAmount ?? null,
      percentValue: input.percentValue ?? null,
      minGuarantee: input.minGuarantee ?? null,
      maxCap: input.maxCap ?? null,
      isActive: input.isActive ?? true,
      branchId: input.branchId ?? null,
      effectiveFrom: input.effectiveFrom ?? null,
      effectiveTo: input.effectiveTo ?? null,
      notes: input.notes ?? null,
    };
    if (input.id != null) {
      await tx.update(courierCommissionRules).set(payload).where(eq(courierCommissionRules.id, input.id));
      return { id: input.id, updated: true };
    }
    const [row] = await tx.insert(courierCommissionRules).values(payload).$returningId();
    return { id: Number(row?.id), updated: false };
  });
}

export async function deleteCommissionRule(id: number) {
  return withTx(async (tx) => {
    await tx.delete(courierCommissionRules).where(eq(courierCommissionRules.id, id));
    return { deleted: true };
  });
}

/**
 * حَسِب عمولة إرساليةٍ افتراضيّة (معاينة) — للعرض في تسوية المندوب قبل ربطها بالقيد المحاسبيّ.
 * `deliveryFee` = ما دفعه العميل للمندوب أجرةً، `orderTotal` = قيمة الطلب (COD).
 * الاختيار من بين كلّ القواعد الفعّالة يُترَك للحاسب المشترك (`computeCourierCommission`).
 */
export async function previewCommission(
  tx: Tx,
  partyId: number,
  deliveryFee: number,
  orderTotal: number,
): Promise<CommissionQuote | null> {
  const rows = await listCommissionRulesForParty(tx, partyId);
  const asInput: CourierCommissionRuleInput[] = rows.map((r) => ({
    id: Number(r.id),
    ruleType: r.ruleType,
    flatAmount: r.flatAmount ?? null,
    percentValue: r.percentValue ?? null,
    minGuarantee: r.minGuarantee ?? null,
    maxCap: r.maxCap ?? null,
    isActive: !!r.isActive,
  }));
  return computeCourierCommission(asInput, { deliveryFee, orderTotal });
}
