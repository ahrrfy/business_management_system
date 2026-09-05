/**
 * ═══ سجلُّ نسخ المنتج والاستعادة (م٦ ق٨) ═══
 *
 * ثلاثُ عمليات فوق `versioning/recordVersion.ts`:
 *   • `listProductVersions`   — النسخ (مَن/متى/السبب) + «الحقول المتغيّرة» لكلّ نسخة.
 *   • `getProductVersionDiff` — «ما الذي تغيّر» حقلاً بحقل بين نسخةٍ والتي تليها (أو الحالة الحاليّة).
 *   • `restoreProductVersion` — الاستعادة = **تعديلٌ جديد بحمولةٍ قديمة** يمرّ بكلّ حرّاس التعديل
 *     (`updateProductWithVariantsTx` بحرّاسه السبعة + حارسَي حدّ العقد) ويكتب لقطةً جديدة للحالة
 *     التي كانت قبل الاستعادة — فالاستعادةُ نفسُها قابلةٌ للتراجع، ولا يُمحى تاريخ.
 *
 * ⛔ استعادةُ تكلفةٍ قديمة على صنفٍ له رصيد **تُرفض** بحارس التكلفة نفسه (`postCostRevaluation`)
 *    — هذا مقصود: الاستعادة لا تملك سلطةً أوسع من التعديل.
 * ⛔ الصورُ خارج الاستعادة (انظر `shared/productSnapshot.ts`) — `images: undefined` لا يمسّها.
 * ⛔ لا يقرأ `ctx` — `Actor` صريح (§٥).
 */
import { TRPCError } from "@trpc/server";
import { inArray } from "drizzle-orm";
import { users } from "../../../drizzle/schema";
import { appErrorMessage } from "@shared/errors";
import { isProductSnapshotDocument, type ProductSnapshotDocument } from "@shared/productSnapshot";
import { changedFieldLabels, diffProductSnapshots, type ProductChangeRow } from "@shared/productVersionDiff";
import type { Tx } from "../../db";
import type { PriceTier } from "../pricing";
import { withTx, type Actor } from "../tx";
import { readVersion, readVersionHistory, restoreToVersion } from "../versioning/recordVersion";
import { getProductForVariantEdit } from "./productEditDocument";
import { buildProductSnapshot } from "./productSnapshot";
import {
  PRODUCT_ENTITY_TYPE,
  assertCostChangeReasonOrThrow,
  assertVariantSanityOrThrow,
  invalidSnapshotError,
  productNotFoundError,
  unitPricingsFromTemplate,
} from "./productUpdateGuards";
import { updateProductWithVariantsTx, type UpdateProductVariantsInput } from "../productEditService";

export type ProductVersionSummary = {
  id: number;
  versionNumber: number;
  /** ISO — يُصاغ في الواجهة بـ`fmtDateTime`. */
  createdAt: string;
  reason: string | null;
  actorUserId: number;
  actorName: string | null;
  /** تسمياتُ الحقول التي غيّرها التعديلُ الذي كتب هذه النسخة (قبل ⇒ النسخة التالية/الحالة الحاليّة). */
  changedFields: string[];
  changeCount: number;
  /** مقابل ماذا حُسب الفرق: النسخة التالية أو الحالة الحاليّة (للأحدث). */
  comparedTo: "next" | "current";
};

export type ProductVersionDiff = {
  versionNumber: number;
  createdAt: string;
  reason: string | null;
  actorName: string | null;
  comparedTo: "next" | "current";
  comparedToVersion: number | null;
  changes: ProductChangeRow[];
};

async function actorNames(tx: Tx, ids: number[]): Promise<Map<number, string | null>> {
  const unique = Array.from(new Set(ids)).filter((n) => Number.isInteger(n) && n > 0);
  if (!unique.length) return new Map();
  const rows = await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, unique));
  return new Map(rows.map((r) => [Number(r.id), r.name ?? null]));
}

function parseSnapshot(payload: unknown, productId: number): ProductSnapshotDocument {
  if (!isProductSnapshotDocument(payload)) {
    throw invalidSnapshotError("اللقطة ليست مستندَ منتجٍ بالصيغة المعروفة (لقطةٌ أقدم أو لكيانٍ آخر)");
  }
  if (payload.id !== productId) {
    throw invalidSnapshotError(`اللقطة تخصّ المنتج #${payload.id} لا #${productId}`);
  }
  return payload;
}

async function currentSnapshot(tx: Tx, productId: number): Promise<ProductSnapshotDocument> {
  const doc = await getProductForVariantEdit(productId, tx);
  if (!doc) throw productNotFoundError(productId);
  return buildProductSnapshot(doc);
}

/** النسخ **الأحدث أوّلاً**، بسقفٍ (الافتراضي ٥٠) — القراءة بلا بوّابة ماليّة (`gate: NONE`). */
export async function listProductVersions(productId: number, limit = 50): Promise<ProductVersionSummary[]> {
  return withTx(async (tx) => {
    const history = await readVersionHistory(tx, PRODUCT_ENTITY_TYPE, productId);
    if (!history.length) return [];
    const current = await currentSnapshot(tx, productId);
    const names = await actorNames(tx, history.map((h) => Number(h.actorUserId)));
    const out: ProductVersionSummary[] = [];
    for (let i = 0; i < history.length; i++) {
      const row = history[i];
      const next = history[i + 1];
      const before = row.payloadJson;
      const after = next ? next.payloadJson : current;
      // لقطةٌ بصيغةٍ غير معروفة لا تُسقط القائمة كلّها — تُعرض بلا فرق.
      const changes =
        isProductSnapshotDocument(before) && isProductSnapshotDocument(after)
          ? diffProductSnapshots(before, after)
          : [];
      out.push({
        id: Number(row.id),
        versionNumber: row.versionNumber,
        createdAt: new Date(row.createdAt).toISOString(),
        reason: row.reason ?? null,
        actorUserId: Number(row.actorUserId),
        actorName: names.get(Number(row.actorUserId)) ?? null,
        changedFields: changedFieldLabels(changes),
        changeCount: changes.length,
        comparedTo: next ? "next" : "current",
      });
    }
    return out.reverse().slice(0, limit);
  }, { gate: "NONE" });
}

export async function getProductVersionDiff(productId: number, versionNumber: number): Promise<ProductVersionDiff> {
  return withTx(async (tx) => {
    const row = await readVersion(tx, PRODUCT_ENTITY_TYPE, productId, versionNumber);
    const before = parseSnapshot(row.payloadJson, productId);
    const history = await readVersionHistory(tx, PRODUCT_ENTITY_TYPE, productId);
    const next = history.find((h) => h.versionNumber > versionNumber);
    const after = next ? parseSnapshot(next.payloadJson, productId) : await currentSnapshot(tx, productId);
    const names = await actorNames(tx, [Number(row.actorUserId)]);
    return {
      versionNumber,
      createdAt: new Date(row.createdAt).toISOString(),
      reason: row.reason ?? null,
      actorName: names.get(Number(row.actorUserId)) ?? null,
      comparedTo: next ? "next" : "current",
      comparedToVersion: next ? next.versionNumber : null,
      changes: diffProductSnapshots(before, after),
    };
  }, { gate: "NONE" });
}

/**
 * يحوّل لقطةً إلى حمولة `updateProductVariants` — **ما كانت الشاشة سترسله** لو حمّلت هذا المستند
 * وضغطت «حفظ»: سعرُ الأساس الخاصّ يُرسَل حين يخالف القالب فقط (دلالة `priceOverride` في الشاشة)،
 * والصورُ لا تُمَسّ، وسببُ الاستعادة يُلحق بالتكلفة كي يمرّ حارسُ السبب على التغيّرات الكبيرة.
 */
export function snapshotToUpdateInput(doc: ProductSnapshotDocument, reason: string): UpdateProductVariantsInput {
  const templateBaseRetail = doc.unitTemplate.find((u) => u.isBaseUnit)?.retail ?? "";
  const prices = (u: { retail: string; wholesale: string; government: string }) => {
    const out: Array<{ priceTier: PriceTier; price: string }> = [];
    if (u.retail.trim()) out.push({ priceTier: "RETAIL", price: u.retail.trim() });
    if (u.wholesale.trim()) out.push({ priceTier: "WHOLESALE", price: u.wholesale.trim() });
    if (u.government.trim()) out.push({ priceTier: "GOVERNMENT", price: u.government.trim() });
    return out;
  };
  return {
    productId: doc.id,
    updateReason: reason,
    name: doc.name,
    productType: doc.productType,
    brand: doc.brand,
    modelName: doc.modelName,
    description: doc.description,
    internalName: doc.internalName,
    storeTitle: doc.storeTitle,
    seoTitle: doc.seoTitle,
    shortTitle: doc.shortTitle,
    posLabel: doc.posLabel,
    invoiceLabel: doc.invoiceLabel,
    marketingCopy: doc.marketingCopy,
    categoryId: doc.categoryId,
    isCustomizable: doc.isCustomizable,
    allowAutoCartRecommendations: doc.allowAutoCartRecommendations,
    isService: doc.isService,
    allowBackorder: doc.allowBackorder,
    isActive: doc.isActive,
    showInReception: doc.showInReception,
    showInPrintPos: doc.showInPrintPos,
    isConsignment: doc.isConsignment,
    consignorId: doc.consignorId,
    unitTemplate: doc.unitTemplate.map((u) => ({
      unitName: u.unitName,
      conversionFactor: u.conversionFactor,
      isBaseUnit: u.isBaseUnit,
      isStoreSaleUnit: u.isStoreSaleUnit,
      prices: prices(u),
    })),
    variants: doc.variants.map((v) => ({
      id: v.id,
      sku: v.sku,
      variantKind: v.variantKind,
      variantName: v.variantName,
      color: v.color,
      colorHex: v.colorHex,
      size: v.size,
      costPrice: v.costPrice,
      costChangeReason: reason,
      baseRetail: v.baseRetail.trim() && v.baseRetail !== templateBaseRetail ? v.baseRetail : undefined,
      minStock: v.minStock,
      reorderPoint: v.reorderPoint,
      isActive: v.isActive,
      image: undefined,
      unitBarcodes: { ...v.unitBarcodes },
    })),
    images: undefined,
  };
}

export type RestoreProductVersionInput = {
  productId: number;
  versionNumber: number;
  /** سببٌ يُلحق باللقطة الجديدة وبالتكلفة (حارس السبب). الافتراضي «استعادة إلى الإصدار N». */
  reason?: string | null;
};

export async function restoreProductVersion(
  input: RestoreProductVersionInput,
  actor: Actor,
): Promise<{ productId: number; restoredFromVersion: number; versionNumber: number | null }> {
  return withTx(async (tx) => {
    const { restoredFromVersion } = await restoreToVersion(
      tx,
      {
        entityType: PRODUCT_ENTITY_TYPE,
        entityId: input.productId,
        versionNumber: input.versionNumber,
        reason: input.reason ?? undefined,
        applyRestore: async (tx2, payload, actor2, restoreReason) => {
          const snapshot = parseSnapshot(payload, input.productId);
          const current = await getProductForVariantEdit(input.productId, tx2);
          if (!current) throw productNotFoundError(input.productId);
          const updateInput = snapshotToUpdateInput(snapshot, restoreReason);
          // حارسا حدّ العقد — يمرّ بهما التعديلُ من الراوتر، فيمرّ بهما الاستعادةُ من هنا.
          for (const v of updateInput.variants) {
            const label = v.color || v.sku;
            assertVariantSanityOrThrow(label, v.costPrice, unitPricingsFromTemplate(updateInput.unitTemplate, v.baseRetail));
            const old = current.variants.find((ov) => ov.id === v.id);
            if (old) assertCostChangeReasonOrThrow(label, old.costPrice, v.costPrice, restoreReason);
          }
          await updateProductWithVariantsTx(tx2, updateInput, actor2);
          return { updated: true };
        },
      },
      actor,
    );
    const history = await readVersionHistory(tx, PRODUCT_ENTITY_TYPE, input.productId);
    const latest = history[history.length - 1];
    if (!latest) {
      // مستحيلٌ نظرياً — التعديلُ كتب لقطةً للتوّ. نُعلنه بدل أن نُبلّغ نجاحاً بلا أثر.
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: appErrorMessage({
          what: "تعذّر إثبات الاستعادة",
          why: "لم تُكتب لقطةٌ للحالة السابقة رغم مرور التعديل",
          doThis: "أعد فتح المنتج وتحقّق من قيمه، وأبلغ المدير",
        }),
      });
    }
    return { productId: input.productId, restoredFromVersion, versionNumber: latest.versionNumber };
  });
}
