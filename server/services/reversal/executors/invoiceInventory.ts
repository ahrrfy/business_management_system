/**
 * منفّذ مخزون فاتورة البيع — **بنداً بند**، والحركةُ الماديّة مجمَّعةً بترتيب الأقفال.
 *
 * أثرُ INVENTORY لفاتورة البيع مُجسَّدٌ على **بند الفاتورة** لا على حركة المخزون: البندُ هو
 * الذي يحمل حقيقة «كم بقي بلا إرجاع» (`baseQuantity − returnedBaseQuantity`)، والمرتجعُ
 * التالف (لا يعود للرفّ) يُنقص المتبقّي **بلا حركةِ مخزون** — لو جُسِّد الأثرُ على الحركات لأعاد
 * الإلغاءُ التالفَ إلى الرفّ (اختبار Codex P2 ١٢/٨ في `saleCancel.test.ts`).
 *
 * ما يفعله لكلّ دفعةٍ من الآثار (كلُّ أثرٍ = بند):
 *  ١) المتبقّي = −outstandingQuantity (الأثر سالبٌ لأنّ البيع خصم).
 *  ٢) البكج يُوسَّع من **لقطة مكوّناته** المحفوظة لحظة البيع (`invoiceItemBundleComponents`)
 *     لا من الوصفة الحيّة — غيابُها يرفض صراحةً.
 *  ٣) الخدمةُ لا رصيدَ لها فلا حركة؛ والتالفُ (`decisions.restock = false`) لا حركةَ له أيضاً.
 *  ٤) الحركاتُ تُجمَّع لكلّ متغيّر وتُطبَّق بترتيب `variantId` التصاعديّ — ترتيبُ الأقفال الحتميّ
 *     نفسُه في `sale/create.ts` و`returnService.ts` (منعُ deadlock).
 *  ٥) يُحدَّث البند: `returnedBaseQuantity += المتبقّي`، و`returnedRestockedBaseQuantity`
 *     يزيد **بما عاد فعلاً وحسب**.
 *  ٦) يُترك في `run.state` ما يحتاجه منفّذُ القيد: كلفةُ كلّ بندٍ ومصيرُه.
 */
import { TRPCError } from "@trpc/server";
import { eq, inArray } from "drizzle-orm";

import { appErrorMessage } from "@shared/errors";

import { invoiceItemBundleComponents, invoiceItems } from "../../../../drizzle/schema";
import { applyMovement } from "../../inventoryService";
import { money, round2 } from "../../money";
import type { EffectExecutor, ExecutionOutcome } from "../types";
import { invoiceContext, writeInventoryState, type ReversedLine } from "./invoiceState";

export const invoiceInventoryExecutor: EffectExecutor = async (tx, effects, run) => {
  const ctx = await invoiceContext(tx, run);
  const restock = run.decisions.restock !== false;
  const flavor = run.decisions.flavor ?? "CANCEL";
  const itemById = new Map(ctx.items.map((i) => [Number(i.id), i]));

  const lines: ReversedLine[] = [];
  for (const effect of effects) {
    if (effect.effectTable !== "invoiceItems" || effect.effectRowId == null) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: appErrorMessage({
          what: "تعذّر عكس أثر المخزون",
          why: `الأثر رقم ${effect.id} لا يشير إلى بند فاتورة (الجدول «${effect.effectTable ?? "—"}»)`,
          doThis: "أوقف العمليّة وأبلغ مسؤول النظام برقم الأثر",
        }),
      });
    }
    const item = itemById.get(Number(effect.effectRowId));
    if (!item) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: appErrorMessage({
          what: "تعذّر عكس أثر المخزون",
          why: `بند الفاتورة رقم ${Number(effect.effectRowId)} لم يعد موجوداً رغم أنّ أثره مسجَّل`,
          doThis: "أوقف العمليّة وأبلغ مسؤول النظام برقم الفاتورة والبند",
        }),
      });
    }
    const remaining = -effect.outstandingQuantity;
    if (remaining <= 0) {
      // متبقٍّ موجبٌ على أثرٍ سالب يعني ابناً زائداً — خللٌ في السجلّ لا يُصلَح بالتخمين.
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: appErrorMessage({
          what: "تعذّر عكس أثر المخزون",
          why: `متبقّي البند ${Number(item.id)} في سجلّ الأثر (${remaining}) ليس موجباً — السجلّ يخالف حقيقة البند`,
          doThis: "أبلغ مسؤول النظام برقم الفاتورة والبند قبل أيّ عكس",
        }),
      });
    }
    const kind = ctx.kindByVariant.get(Number(item.variantId)) ?? "STOCKED";
    lines.push({
      itemId: Number(item.id),
      variantId: Number(item.variantId),
      kind,
      isGift: !!item.isGift,
      unitCost: money(item.unitCost),
      quantity: remaining,
      restocked: restock && kind !== "SERVICE",
    });
  }

  // ═══ لقطاتُ مكوّنات البكج (لا الوصفة الحيّة) ═══
  const bundleItemIds = lines.filter((l) => l.kind === "BUNDLE").map((l) => l.itemId);
  const snapshotByItem = new Map<number, Array<{ componentVariantId: number; componentBaseQuantity: number }>>();
  if (bundleItemIds.length) {
    const rows = await tx
      .select({
        invoiceItemId: invoiceItemBundleComponents.invoiceItemId,
        componentVariantId: invoiceItemBundleComponents.componentVariantId,
        componentBaseQuantity: invoiceItemBundleComponents.componentBaseQuantity,
      })
      .from(invoiceItemBundleComponents)
      .where(inArray(invoiceItemBundleComponents.invoiceItemId, bundleItemIds));
    for (const r of rows) {
      const iid = Number(r.invoiceItemId);
      const list = snapshotByItem.get(iid) ?? [];
      list.push({ componentVariantId: Number(r.componentVariantId), componentBaseQuantity: Number(r.componentBaseQuantity) });
      snapshotByItem.set(iid, list);
    }
  }

  // ═══ حركاتُ المخزون المجمَّعة لكلّ متغيّر ═══
  const aggregated = new Map<number, number>();
  const variantsByItem = new Map<number, number[]>();
  for (const line of lines) {
    if (!line.restocked) continue;
    if (line.kind === "BUNDLE") {
      const def = snapshotByItem.get(line.itemId) ?? [];
      if (!def.length) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: flavor === "CANCEL"
            ? `البكج (بند ${line.itemId}) بلا لقطة مكوّنات محفوظة — لا يمكن إعادة تخزينه آلياً`
            : appErrorMessage({
                what: "تعذّر إرجاع البكج إلى المخزون",
                why: `البند ${line.itemId} بكجٌ بِيع قبل 7/7/2026 ولا لقطة محفوظة لمكوّناته وقتَها — وإعادتُه بوصفة اليوم قد تُعيد للمخزون غير ما خرج منه`,
                doThis: "ألغِ هذا السطر من المرتجع، وأرجِع مكوّنات البكج فرادى بأصنافها وكمّياتها كما استلمتها من الزبون",
              }),
        });
      }
      const vids: number[] = [];
      for (const c of def) {
        aggregated.set(c.componentVariantId, (aggregated.get(c.componentVariantId) ?? 0) + c.componentBaseQuantity * line.quantity);
        vids.push(c.componentVariantId);
      }
      variantsByItem.set(line.itemId, vids);
    } else {
      aggregated.set(line.variantId, (aggregated.get(line.variantId) ?? 0) + line.quantity);
      variantsByItem.set(line.itemId, [line.variantId]);
    }
  }
  const movementIdByVariant = new Map<number, number>();
  for (const vid of Array.from(aggregated.keys()).sort((a, b) => a - b)) {
    const qty = aggregated.get(vid)!;
    if (qty <= 0) continue;
    const mv = await applyMovement(tx, {
      variantId: vid,
      branchId: Number(ctx.invoice.branchId),
      baseQuantity: qty,
      movementType: "RETURN",
      referenceType: "RETURN",
      referenceId: run.documentId,
      createdBy: run.actor.userId,
      notes: flavor === "CANCEL" ? "إلغاء فاتورة بيع — إرجاع كامل البضاعة للمخزون" : undefined,
    });
    // متغيّرٌ خدميّ يُعيد movementId=0 بلا رصيد — لا نختلق مرجعاً له (Codex #957).
    if (mv.movementId) movementIdByVariant.set(vid, mv.movementId);
  }

  // ═══ تحديثُ البند: المُرجَع كلُّه، والعائدُ للرفّ بما عاد فعلاً ═══
  const outcomes: ExecutionOutcome[] = [];
  for (const line of lines) {
    const item = itemById.get(line.itemId)!;
    const physicalMovementIds = (variantsByItem.get(line.itemId) ?? [])
      .map((vid) => movementIdByVariant.get(vid))
      .filter((id): id is number => id != null);
    await tx
      .update(invoiceItems)
      .set({
        returnedBaseQuantity: (item.returnedBaseQuantity ?? 0) + line.quantity,
        ...(restock
          ? { returnedRestockedBaseQuantity: (item.returnedRestockedBaseQuantity ?? 0) + line.quantity }
          : {}),
      })
      .where(eq(invoiceItems.id, line.itemId));
    outcomes.push({
      status: "REVERSED",
      signedQuantity: line.quantity,
      effectTable: physicalMovementIds.length ? "inventoryMovements" : "invoiceItems",
      effectRowId: physicalMovementIds[0] ?? line.itemId,
      payloadJson: {
        variantId: line.variantId,
        kind: line.kind,
        physicalRestock: line.restocked && physicalMovementIds.length > 0,
        movementIds: physicalMovementIds,
        restockDecision: restock,
      },
    });
  }
  writeInventoryState(run, { lines, restock });
  void round2;
  return outcomes;
};
