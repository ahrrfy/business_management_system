/**
 * commissionComparison — تقرير مقارنة العمولة (Slice K، ٢٩/٨/٢٦).
 *
 * ⚠️ إعادة كتابة كاملة بعد مراجعة Codex على PR #884:
 *
 *  - **P1 #1 (feesTotal = 0)**: النسخة الأولى جمعت `deliveryRemittances.feesTotal` وهو مثبَّت
 *    صفراً في `remittance.ts:221` لأنّ الأجور تُدفع بمسارٍ منفصل عبر `fees.ts` ⇒ كلّ الجهات
 *    تظهر بأجرةٍ صفر ودلتاٍ سالبة. الآن الأساس مأخوذٌ من `deliveryConsignments.deliveryFee`
 *    لكلّ إرساليةٍ مُسلَّمة — الأجرة الحقيقيّة التي كسبتها الجهة.
 *
 *  - **P1 #2 (تسرّبُ بيانات فروع)**: `scopedBranchId` كان يُتجاهَل — محاسبُ فرعٍ يستطيع رؤية
 *    أجور وعمولات فروعٍ أخرى. الآن الفلتر مُطبَّق على مستوى الإرسالية.
 *
 *  - **P2 #8 (double-count على الجزئي)**: التوريد يُخزّن العمولة لكلّ سطرٍ يشمل الإرسالية،
 *    فتوريدان جزئيّان لإرساليةٍ واحدة كانا يجمعان `flatAmount` مرّتين رغم أنّ H2 يدفعه مرّةً.
 *    الآن الاحتساب لكلّ إرساليةٍ **متمايزة** (`DISTINCT consignment`) بلا احتساب توريديّ.
 *
 *  - **P2 #9 (H2 مُفعَّل بلا قاعدةٍ فعّالة)**: `useCommissionForSettlement` قد يبقى TRUE بعد
 *    حذف/تعطيل القاعدة الفعّالة ⇒ الشارة كذبت. الآن نحسب `effectiveActive = flag AND hasRule`.
 *
 *  - **P2 #8/H2 parity**: نستعمل نفس المعاملات التي يستعملها H2 في `fees.ts`:
 *    `computeCourierCommission(rules, {deliveryFee: fee, orderTotal: 0})` — تطابق حسابيّ.
 */
import { and, eq, gte, isNull, lt, or } from "drizzle-orm";
import Decimal from "decimal.js";
import { courierCommissionRules, deliveryConsignments, deliveryParties } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { utcDayStart, utcNextDayStart } from "../businessDay";
import { money, round2 } from "../money";
import { computeCourierCommission, type CourierCommissionRuleInput } from "@shared/courierCommission";

export interface CommissionComparisonInput {
  scopedBranchId: number | null;
  fromDate?: string | null;
  toDate?: string | null;
}

export interface CommissionComparisonRow {
  partyId: number;
  partyName: string;
  /** علَم opt-in لتفعيل H2 على الجهة (`deliveryParties.useCommissionForSettlement`). */
  useCommissionFlag: boolean;
  /** هل الجهة لديها قاعدة عمولةٍ فعّالة الآن؟ H2 لا يعمل بلا هذا حتى لو كان العلَم TRUE. */
  hasActiveRule: boolean;
  /** الحالة الفعليّة لـH2: `flag && hasActiveRule` — هي ما يقرّره fees.ts فعلياً. */
  effectiveActive: boolean;
  feesTotal: string;
  commissionTotal: string;
  delta: string;
  /** عدد الإرساليّات المُسلَّمة المُتفَرِّدة في النافذة (لا سطور توريد). */
  consignmentCount: number;
}

export async function commissionComparison(
  input: CommissionComparisonInput,
): Promise<CommissionComparisonRow[]> {
  const db = getDb();
  if (!db) return [];

  // Codex P2 #7 — رفضُ نافذةٍ مقلوبة بلا لبس (الرسالة تصل للشاشة).
  if (input.fromDate && input.toDate && input.fromDate > input.toDate) {
    throw new Error("نطاق التاريخ مقلوب: «من» أكبر من «إلى»");
  }

  // 1) الجهات (بعزل فرع). الجهات المشتركة (`branchId IS NULL`) مرئية لكلّ الفروع.
  const partyConds = [];
  if (input.scopedBranchId != null) {
    partyConds.push(or(
      eq(deliveryParties.branchId, input.scopedBranchId),
      isNull(deliveryParties.branchId),
    ));
  }
  const parties = await db
    .select({
      id: deliveryParties.id,
      name: deliveryParties.name,
      useCommissionFlag: deliveryParties.useCommissionForSettlement,
    })
    .from(deliveryParties)
    .where(partyConds.length ? and(...partyConds) : undefined);

  const results: CommissionComparisonRow[] = [];

  for (const p of parties) {
    // 2) قواعدُ العمولة النشِطة للجهة (خاصّتها + الافتراضيّة العامّة).
    const rulesRows = await db
      .select()
      .from(courierCommissionRules)
      .where(or(
        eq(courierCommissionRules.partyId, Number(p.id)),
        isNull(courierCommissionRules.partyId),
      ));
    const rulesInput: CourierCommissionRuleInput[] = rulesRows.map((r) => ({
      id: Number(r.id),
      ruleType: r.ruleType,
      flatAmount: r.flatAmount ?? null,
      percentValue: r.percentValue ?? null,
      minGuarantee: r.minGuarantee ?? null,
      maxCap: r.maxCap ?? null,
      isActive: !!r.isActive,
    }));
    const hasActiveRule = rulesInput.some((r) => r.isActive);

    // 3) الإرساليّات المُسلَّمة في النافذة (بعزل فرع). لا سطور توريد ⇒ لا تكرار.
    const cnConds = [
      eq(deliveryConsignments.partyId, Number(p.id)),
      eq(deliveryConsignments.parcelStatus, "DELIVERED"),
    ];
    if (input.scopedBranchId != null) {
      cnConds.push(eq(deliveryConsignments.branchId, input.scopedBranchId));
    }
    if (input.fromDate) {
      cnConds.push(gte(deliveryConsignments.courierDeliveredAt, utcDayStart(input.fromDate)));
    }
    if (input.toDate) {
      cnConds.push(lt(deliveryConsignments.courierDeliveredAt, utcNextDayStart(input.toDate)));
    }
    const cns = await db
      .select({
        id: deliveryConsignments.id,
        deliveryFee: deliveryConsignments.deliveryFee,
      })
      .from(deliveryConsignments)
      .where(and(...cnConds));

    if (cns.length === 0) continue;

    // 4) الاحتساب — مطابقٌ لما يفعله fees.ts في H2 (نفس معاملات `previewCommission`).
    let feesTotal = money(0);
    let commissionTotal = money(0);
    for (const cn of cns) {
      const fee = money(cn.deliveryFee ?? "0");
      feesTotal = feesTotal.plus(fee);
      const quote = computeCourierCommission(rulesInput, {
        deliveryFee: Number(fee.toFixed(2)),
        orderTotal: 0,
      });
      if (quote != null) {
        commissionTotal = commissionTotal.plus(new Decimal(quote.commission));
      } else {
        // بلا قاعدةٍ فعّالة ⇒ العمولة = الأجرة (لا وفر — يعكس السلوك الفعليّ لـH2).
        commissionTotal = commissionTotal.plus(fee);
      }
    }

    // نستبعد الجهات بلا قاعدة فعّالة كلياً (تقريرٌ لقرار تفعيل H2 لا للتاريخ الميت).
    if (!hasActiveRule) continue;

    const delta = feesTotal.minus(commissionTotal);
    results.push({
      partyId: Number(p.id),
      partyName: p.name ?? "—",
      useCommissionFlag: !!p.useCommissionFlag,
      hasActiveRule,
      effectiveActive: !!p.useCommissionFlag && hasActiveRule,
      feesTotal: round2(feesTotal).toFixed(2),
      commissionTotal: round2(commissionTotal).toFixed(2),
      delta: round2(delta).toFixed(2),
      consignmentCount: cns.length,
    });
  }

  return results.sort((a, b) => Number(b.delta) - Number(a.delta));
}
