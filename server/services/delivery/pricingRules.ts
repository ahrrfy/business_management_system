/**
 * قواعد تسعير التوصيل — CRUD + معاينة (Slice I، ٢٩/٨/٢٦).
 *
 * الجداول موجودة (Slice 7، هجرة 0279): `deliveryZones` + `deliveryPricingRules`. الحسابيّة
 * موجودة (`shared/deliveryPricing.ts`، ١٣ اختبار مارّ). هذه الطبقة تُغلق الفجوة بواجهةٍ إدارية.
 *
 * الاستعمال المتوقّع:
 *  - المدير يعرّف مناطق التسعير (بغداد المركز، الأطراف، إلخ) مع رمزٍ مطابقٍ لـ`Governorate.id`.
 *  - يضع قاعدةً واحدةً على الأقلّ لكلّ منطقة (FLAT_FEE في البداية — PER_KM/WEIGHT جاهزةٌ للتوسّع).
 *  - المستهلك (كاشير الاستقبال مستقبلاً) يستدعي `previewDeliveryQuote` لعرض أجرةٍ اقتراحية.
 */
import { and, asc, eq } from "drizzle-orm";
import { deliveryPricingRules, deliveryZones } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { withTx } from "../tx";
import {
  computeDeliveryFee,
  type DeliveryPricingRuleInput,
  type DeliveryQuote,
} from "@shared/deliveryPricing";

export async function listDeliveryZones(tx: Tx) {
  return tx.select().from(deliveryZones).orderBy(asc(deliveryZones.displayOrder), asc(deliveryZones.name));
}

export async function listPricingRulesForZone(tx: Tx, zoneId: number) {
  return tx
    .select()
    .from(deliveryPricingRules)
    .where(eq(deliveryPricingRules.zoneId, zoneId))
    .orderBy(asc(deliveryPricingRules.id));
}

export interface SaveDeliveryZoneInput {
  id?: number | null;
  code: string;
  name: string;
  preferredBranchId?: number | null;
  isActive?: boolean;
  displayOrder?: number;
}
export async function saveDeliveryZone(input: SaveDeliveryZoneInput) {
  return withTx(async (tx) => {
    const payload = {
      code: input.code.trim(),
      name: input.name.trim(),
      preferredBranchId: input.preferredBranchId ?? null,
      isActive: input.isActive ?? true,
      displayOrder: input.displayOrder ?? 0,
    };
    if (input.id != null) {
      await tx.update(deliveryZones).set(payload).where(eq(deliveryZones.id, input.id));
      return { id: input.id, updated: true };
    }
    const [row] = await tx.insert(deliveryZones).values(payload).$returningId();
    return { id: Number(row?.id), updated: false };
  });
}

export async function deleteDeliveryZone(id: number) {
  // CASCADE على `deliveryPricingRules` يمسحها آلياً — لا مسحٌ يدويّ.
  return withTx(async (tx) => {
    await tx.delete(deliveryZones).where(eq(deliveryZones.id, id));
    return { deleted: true };
  });
}

export interface SavePricingRuleInput {
  id?: number | null;
  zoneId: number;
  ruleType: "FLAT_FEE" | "PER_KM" | "WEIGHT";
  baseFee: string;
  perKmFee?: string | null;
  perKgFee?: string | null;
  minFee?: string | null;
  maxFee?: string | null;
  isActive?: boolean;
  branchId?: number | null;
  notes?: string | null;
}
export async function savePricingRule(input: SavePricingRuleInput) {
  return withTx(async (tx) => {
    const payload = {
      zoneId: input.zoneId,
      ruleType: input.ruleType,
      baseFee: input.baseFee,
      perKmFee: input.perKmFee ?? null,
      perKgFee: input.perKgFee ?? null,
      minFee: input.minFee ?? null,
      maxFee: input.maxFee ?? null,
      isActive: input.isActive ?? true,
      branchId: input.branchId ?? null,
      notes: input.notes ?? null,
    };
    if (input.id != null) {
      await tx.update(deliveryPricingRules).set(payload).where(eq(deliveryPricingRules.id, input.id));
      return { id: input.id, updated: true };
    }
    const [row] = await tx.insert(deliveryPricingRules).values(payload).$returningId();
    return { id: Number(row?.id), updated: false };
  });
}

export async function deletePricingRule(id: number) {
  return withTx(async (tx) => {
    await tx.delete(deliveryPricingRules).where(eq(deliveryPricingRules.id, id));
    return { deleted: true };
  });
}

/** معاينة الأجرة لمنطقةٍ ومسافة/وزن — تُستَعمل في UI الإدارة وفي كاشير الاستقبال مستقبلاً. */
export async function previewDeliveryQuote(
  tx: Tx,
  zoneId: number,
  distanceKm?: number | null,
  weightKg?: number | null,
): Promise<DeliveryQuote | null> {
  const rows = await listPricingRulesForZone(tx, zoneId);
  const asInput: DeliveryPricingRuleInput[] = rows.map((r) => ({
    id: Number(r.id),
    ruleType: r.ruleType,
    baseFee: r.baseFee,
    perKmFee: r.perKmFee ?? null,
    perKgFee: r.perKgFee ?? null,
    minFee: r.minFee ?? null,
    maxFee: r.maxFee ?? null,
    isActive: !!r.isActive,
  }));
  return computeDeliveryFee(asInput, { distanceKm: distanceKm ?? null, weightKg: weightKg ?? null });
}
