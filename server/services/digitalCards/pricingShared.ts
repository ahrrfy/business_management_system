/**
 * أسعار بداية اليوم (ش٤) — أنواع وأدوات مشتركة بين pricingDraft/pricingPublish/pricingMismatch.
 * لا منطق عملٍ مستقلّ هنا؛ فقط ما تحتاجه أكثر من وحدة.
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import {
  auditLogs,
  branches,
  digitalOfferingBranches,
  digitalOfferings,
  digitalPriceBatches,
  digitalProviders,
  products,
} from "../../../drizzle/schema";
import type { DB, Tx } from "../../db";
import { money, toDbMoney } from "../money";
import type { Actor } from "../tx";
import { redactAuditValue } from "../auditService";
import { computeSellPrice, type PricingMode } from "./pricingCalc";

export interface SheetScope {
  branchId: number;
  providerId: number;
  businessDate: string;
}

export interface PriceDraftScope extends SheetScope {
  /** مبرّر قرار السعر؛ يثبت مع الدفعة المنشورة ويخدم التدقيق اللاحق. */
  changeReason?: string | null;
}

export interface DraftLineInput {
  offeringId: number;
  /** تكلفة البطاقة عند المزوّد؛ هي التي تُخصم من المحفظة عند البيع. */
  providerShare: string;
  /** سعر البيع للجمهور. القديم اختياري للتوافق، أما الواجهة الحالية فترسله دائماً. */
  sellPrice?: string;
}

/** قواعد تسعير عرضٍ ما — تُقرأ من التعريف لا من العميل. */
export type OfferingRules = {
  offeringId: number;
  name: string;
  pricingMode: PricingMode;
  fixedMargin: string;
  marginPercent: string;
  minimumMargin: string;
  roundingStep: string;
};

/* ────────── التدقيق (داخل المعاملة — ذرّيّ مع التغيير) ────────── */

export async function auditLog(
  tx: Tx,
  actor: Actor,
  action: string,
  entityId: number,
  details: unknown,
): Promise<void> {
  await tx.insert(auditLogs).values({
    userId: actor.userId,
    branchId: actor.branchId,
    action,
    entityType: "digitalPriceBatch",
    entityId: String(entityId),
    newValue: redactAuditValue(details),
  });
}

export async function latestBigChangeApproval(tx: Tx, batchId: number) {
  const [row] = await tx
    .select({ userId: auditLogs.userId, newValue: auditLogs.newValue })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.action, "digitalCards.pricing.bigChangeApproved"),
        eq(auditLogs.entityType, "digitalPriceBatch"),
        eq(auditLogs.entityId, String(batchId)),
      ),
    )
    .orderBy(desc(auditLogs.id))
    .limit(1);
  return row ?? null;
}

/* ────────── مساعدات ────────── */

/** العروض الفعّالة لمزوّد داخل فرع (مُفعَّلة على مستوى العرض **وعلى مستوى ربط الفرع**). */
export async function activeOfferings(
  runner: DB | Tx,
  branchId: number,
  providerId: number,
): Promise<OfferingRules[]> {
  const rows = await runner
    .select({
      offeringId: digitalOfferings.id,
      name: products.name,
      pricingMode: digitalOfferings.pricingMode,
      fixedMargin: digitalOfferings.fixedMargin,
      marginPercent: digitalOfferings.marginPercent,
      minimumMargin: digitalOfferings.minimumMargin,
      roundingStep: digitalOfferings.roundingStep,
    })
    .from(digitalOfferings)
    .innerJoin(products, eq(digitalOfferings.productId, products.id))
    .innerJoin(
      digitalOfferingBranches,
      eq(digitalOfferingBranches.offeringId, digitalOfferings.id),
    )
    .where(
      and(
        eq(digitalOfferings.providerId, providerId),
        eq(digitalOfferings.isActive, true),
        eq(digitalOfferingBranches.branchId, branchId),
        eq(digitalOfferingBranches.isActive, true),
      ),
    )
    .orderBy(digitalOfferings.id);
  return rows as OfferingRules[];
}

/** يحسب السعر من الحصة + قواعد العرض، ويرفض هامشاً دون الحدّ الأدنى. */
export function priceFor(
  rules: OfferingRules,
  providerShare: string,
  sellPrice: string | undefined,
  enforceMinimum: boolean,
) {
  const share = money(providerShare);
  if (share.lt(0)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `حصة المزوّد لا تكون سالبة — «${rules.name}»` });
  }
  if (sellPrice == null && rules.pricingMode === "FIXED_SELL_PRICE") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `سعر البيع مطلوب صراحةً للبطاقة «${rules.name}» ذات السعر الثابت`,
    });
  }
  // التسعير المباشر هو المسار المعتاد: تكلفة + سعر بيع واضحان. نُبقي اشتقاق
  // القاعدة القديمة فقط لطلبات متوافقة أقدم لم ترسل سعر البيع بعد.
  const r =
    sellPrice != null
      ? (() => {
          const sell = money(sellPrice);
          if (sell.lt(0)) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `سعر البيع لا يكون سالباً — «${rules.name}»`,
            });
          }
          return {
            providerShare: toDbMoney(share),
            sellPrice: toDbMoney(sell),
            marginAmount: toDbMoney(sell.minus(share)),
          };
        })()
      : computeSellPrice({
          pricingMode: rules.pricingMode,
          providerShare: toDbMoney(share),
          fixedMargin: rules.fixedMargin,
          marginPercent: rules.marginPercent,
          roundingStep: rules.roundingStep,
        });
  if (enforceMinimum && money(r.marginAmount).lt(0)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `سعر بيع «${rules.name}» أقل من تكلفة الشراء — لا يُنشر سعر بخسارة`,
    });
  }
  if (enforceMinimum && money(r.marginAmount).lt(money(rules.minimumMargin))) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `هامش «${rules.name}» (${r.marginAmount}) أقلّ من الحدّ الأدنى (${rules.minimumMargin}). ` +
        `عدّل حصة المزوّد أو قاعدة الربح قبل النشر.`,
    });
  }
  return r;
}

export async function lockBatch(tx: Tx, batchId: number) {
  const [batch] = await tx
    .select()
    .from(digitalPriceBatches)
    .where(eq(digitalPriceBatches.id, batchId))
    .for("update");
  if (!batch) throw new TRPCError({ code: "NOT_FOUND", message: "دُفعة الأسعار غير موجودة" });
  return batch;
}

/**
 * قفل ثابت لنطاق النشر. قفل المزود يحسم حالة «لا توجد دفعة منشورة بعد»، ثم نقفل
 * الدفعة المنشورة الحالية نفسها. يجب استدعاؤه قبل قراءة baseline في الاعتماد والنشر.
 */
export async function lockPublishedScope(tx: Tx, branchId: number, providerId: number) {
  const [provider] = await tx
    .select({ id: digitalProviders.id, isActive: digitalProviders.isActive })
    .from(digitalProviders)
    .where(eq(digitalProviders.id, providerId))
    .for("update");
  if (!provider) throw new TRPCError({ code: "NOT_FOUND", message: "المزوّد غير موجود" });
  if (!provider.isActive) throw new TRPCError({ code: "BAD_REQUEST", message: "المزوّد معطّل" });

  const [published] = await tx
    .select({ id: digitalPriceBatches.id, businessDate: digitalPriceBatches.businessDate })
    .from(digitalPriceBatches)
    .where(
      and(
        eq(digitalPriceBatches.branchId, branchId),
        eq(digitalPriceBatches.providerId, providerId),
        eq(digitalPriceBatches.status, "PUBLISHED"),
      ),
    )
    .for("update");
  return published
    ? { id: Number(published.id), businessDate: String(published.businessDate) }
    : null;
}

export async function assertScopeExists(runner: DB | Tx, branchId: number, providerId: number) {
  const [branch] = await runner.select({ id: branches.id }).from(branches).where(eq(branches.id, branchId)).limit(1);
  if (!branch) throw new TRPCError({ code: "NOT_FOUND", message: "الفرع غير موجود" });
  const [provider] = await runner
    .select({ id: digitalProviders.id, isActive: digitalProviders.isActive })
    .from(digitalProviders)
    .where(eq(digitalProviders.id, providerId))
    .limit(1);
  if (!provider) throw new TRPCError({ code: "NOT_FOUND", message: "المزوّد غير موجود" });
  if (!provider.isActive) throw new TRPCError({ code: "BAD_REQUEST", message: "المزوّد معطَّل" });
}
