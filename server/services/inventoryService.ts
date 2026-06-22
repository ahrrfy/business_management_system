import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";
import { branchStock, inventoryMovements, productUnits, productVariants, products } from "../../drizzle/schema";
import type { Tx } from "../db";
import type { DecimalInput } from "./money";
import { extractInsertId } from "../lib/insertId";

/** يَتحقّق إن كان المُتغيّر يَنتمي لمُنتج خِدمي (لا مَخزون). يُستعمَل لِتجاوز inventoryMovements/branchStock. */
async function isServiceVariant(tx: Tx, variantId: number): Promise<boolean> {
  const rows = await tx
    .select({ isService: products.isService })
    .from(productVariants)
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(eq(productVariants.id, variantId))
    .limit(1);
  return !!rows[0]?.isService;
}

export type MovementType = "IN" | "OUT" | "ADJUST" | "RETURN" | "TRANSFER_IN" | "TRANSFER_OUT";
type DirectionalType = Exclude<MovementType, "ADJUST">;

const SIGN: Record<DirectionalType, 1 | -1> = {
  IN: 1,
  RETURN: 1,
  TRANSFER_IN: 1,
  OUT: -1,
  TRANSFER_OUT: -1,
};
const DEDUCTING = new Set<DirectionalType>(["OUT", "TRANSFER_OUT"]);

/** INV-001: يعيد بناء الدلتا الموقَّعة لحركة ADJUST من علامة «(فرق ±D)» التي يُلحقها setStock في
 *  **نهاية** النص دائماً. مُرتكَز على القوسين + نهاية السلسلة ($) لا أوّل مطابقة فضفاضة — وإلّا
 *  لانتُزِعت قيمةٌ من ملاحظة المستخدم الحرّة (مثل «تصحيح فرق ٢٠٠ قطعة») بدل العلامة الحقيقية
 *  (ثغرة تحقيق ٢٠/٦). null = لا علامة مطابِقة ⇒ يَتجاهلها المُستدعي. */
export function adjustSignedDelta(notes: string | null): number | null {
  if (!notes) return null;
  const m = notes.match(/\(فرق\s*([+\-−]?)\s*(\d+)\)\s*$/);
  if (!m) return null;
  const sign = m[1] === "-" || m[1] === "−" ? -1 : 1;
  return sign * parseInt(m[2], 10);
}

/** المصدر الوحيد لإشارة حركات المخزون (الكاردكس + الجرد يَستعملانه ⇒ لا تَباعُد). الكمية مخزَّنة
 *  موجبةً والاتجاه من النوع: IN/RETURN/TRANSFER_IN=+، OUT/TRANSFER_OUT=−، وADJUST من علامة النص. */
export function signedMoveQty(movementType: string, quantity: number, notes: string | null): number {
  if (movementType === "ADJUST") return adjustSignedDelta(notes) ?? 0;
  const s = SIGN[movementType as DirectionalType];
  return s === undefined ? 0 : s * quantity;
}

export interface ApplyMovementArgs {
  variantId: number;
  branchId: number;
  baseQuantity: number; // positive integer, in base units
  movementType: DirectionalType; // ADJUST goes through setStock only
  referenceType?: string;
  referenceId?: number;
  relatedBranchId?: number;
  notes?: string;
  createdBy?: number;
  /**
   * يسمح للرصيد بالنزول تحت الصفر لحركة الخصم (OUT/TRANSFER_OUT) — **للمواد الاستهلاكية فقط**
   * (ورق/حبر في نقطة بيع الطباعة): الخدمة لا تُرفض حين يُظهر النظام نفاد المادة، لكن الاستهلاك
   * يُسجَّل كاملاً (حركة + رصيد سالب = إشارة صادقة لإعادة التزويد/الجرد). لا تستعمله لبضاعة إعادة البيع.
   * الافتراضي false ⇒ السلوك التاريخي (حظر البيع الزائد) محفوظ تماماً لكل المستدعين الحاليين.
   */
  allowNegative?: boolean;
}
export interface ApplyMovementResult {
  movementId: number;
  newQuantity: number;
}

/** Read current stock under a row lock, then write a movement + the new branchStock. */
export async function applyMovement(tx: Tx, a: ApplyMovementArgs): Promise<ApplyMovementResult> {
  if (!Number.isInteger(a.baseQuantity) || a.baseQuantity <= 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الكمية الأساس يجب أن تكون عدداً صحيحاً موجباً" });
  }

  // مُنتج خِدمي: لا تَتبُّع مَخزون. التَحويل بين الفُروع مَمنوع منطقياً (الخَدمة لا تُحَوَّل
  // كَأنها بِضاعة). البَيع/الشِراء/المُرتجَع/التَسوية: نَخرج بِنَتيجة اصطناعية بِلا حركة ولا
  // كِتابة على branchStock. الإيراد/التَكلفة يَستمرّ عَبر مَسارات أخرى (saleService، COGS).
  if (await isServiceVariant(tx, a.variantId)) {
    if (a.movementType === "TRANSFER_IN" || a.movementType === "TRANSFER_OUT") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يُمكن تَحويل مُنتج خِدمي بين الفُروع" });
    }
    return { movementId: 0, newQuantity: 0 };
  }

  // اضمن وجود صفّ الرصيد قبل القفل — FOR UPDATE لا يقفل شيئاً على صفّ غير موجود (يتسرّب بيعٌ زائد/فقدُ تحديث).
  await tx
    .insert(branchStock)
    .values({ variantId: a.variantId, branchId: a.branchId, quantity: 0 })
    .onDuplicateKeyUpdate({ set: { variantId: sql`${branchStock.variantId}` } });

  const rows = await tx
    .select({ quantity: branchStock.quantity })
    .from(branchStock)
    .where(and(eq(branchStock.variantId, a.variantId), eq(branchStock.branchId, a.branchId)))
    .for("update")
    .limit(1);
  const currentQty = rows[0]?.quantity ?? 0;

  const sign = SIGN[a.movementType];
  if (DEDUCTING.has(a.movementType) && currentQty < a.baseQuantity && !a.allowNegative) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `المخزون غير كافٍ: المتاح ${currentQty}، المطلوب ${a.baseQuantity}`,
    });
  }
  const signedDelta = sign * a.baseQuantity;
  const newQuantity = currentQty + signedDelta;

  const res = await tx.insert(inventoryMovements).values({
    variantId: a.variantId,
    branchId: a.branchId,
    movementType: a.movementType,
    quantity: a.baseQuantity,
    referenceType: a.referenceType,
    referenceId: a.referenceId,
    relatedBranchId: a.relatedBranchId,
    notes: a.notes,
    createdBy: a.createdBy,
  });
  const movementId = extractInsertId(res);

  // كتابة نسبية تحت القفل: تشفى ذاتياً ولا تطمس تحديثاً متزامناً (بخلاف الكتابة المطلقة السابقة).
  await tx
    .update(branchStock)
    .set({ quantity: sql`${branchStock.quantity} + ${signedDelta}` })
    .where(and(eq(branchStock.variantId, a.variantId), eq(branchStock.branchId, a.branchId)));

  return { movementId, newQuantity };
}

export interface ConvertResult {
  baseQuantity: number;
  conversionFactor: string;
  isBaseUnit: boolean;
}

/** Convert a quantity expressed in a productUnit into integer base units. */
export async function convertToBaseQuantity(
  tx: Tx,
  productUnitId: number,
  quantity: DecimalInput,
  variantId?: number
): Promise<ConvertResult> {
  const rows = await tx
    .select({
      factor: productUnits.conversionFactor,
      isBase: productUnits.isBaseUnit,
      isActive: productUnits.isActive,
      variantId: productUnits.variantId,
    })
    .from(productUnits)
    .where(eq(productUnits.id, productUnitId))
    .limit(1);
  const u = rows[0];
  if (!u) throw new TRPCError({ code: "NOT_FOUND", message: "وحدة المنتج غير موجودة" });
  if (variantId !== undefined && Number(u.variantId) !== variantId) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الوحدة لا تخص المتغيّر المُرسَل" });
  }
  if (u.isActive === false) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "وحدة المنتج معطّلة" });
  }
  const q = new Decimal(quantity);
  const f = new Decimal(u.factor);
  if (q.lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "الكمية يجب أن تكون موجبة" });
  if (f.lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "معامل التحويل غير صالح" });
  const base = q.mul(f);
  if (!base.isInteger()) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `الكمية الأساس الناتجة (${base.toString()}) ليست عدداً صحيحاً — راجع الكمية أو معامل التحويل`,
    });
  }
  return { baseQuantity: base.toNumber(), conversionFactor: f.toString(), isBaseUnit: !!u.isBase };
}

export interface SetStockArgs {
  variantId: number;
  branchId: number;
  targetQuantity: number;
  referenceType?: string;
  referenceId?: number;
  notes?: string;
  createdBy?: number;
}

/** Absolute stock adjustment (ADJUST). Records abs(delta) and the direction in notes. */
export async function setStock(tx: Tx, a: SetStockArgs): Promise<ApplyMovementResult> {
  if (!Number.isInteger(a.targetQuantity) || a.targetQuantity < 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الرصيد المستهدف يجب أن يكون صحيحاً غير سالب" });
  }
  // مُنتج خِدمي: لا تَسوية مَخزون لـ«ما لا مَخزون له». نَتجاهل بِنَتيجة اصطناعية.
  if (await isServiceVariant(tx, a.variantId)) {
    return { movementId: 0, newQuantity: 0 };
  }
  // اضمن وجود الصفّ قبل القفل (نفس علّة FOR UPDATE على صفّ غير موجود).
  await tx
    .insert(branchStock)
    .values({ variantId: a.variantId, branchId: a.branchId, quantity: 0 })
    .onDuplicateKeyUpdate({ set: { variantId: sql`${branchStock.variantId}` } });
  const rows = await tx
    .select({ quantity: branchStock.quantity })
    .from(branchStock)
    .where(and(eq(branchStock.variantId, a.variantId), eq(branchStock.branchId, a.branchId)))
    .for("update")
    .limit(1);
  const currentQty = rows[0]?.quantity ?? 0;
  const delta = a.targetQuantity - currentQty;

  // علامة الإشارة «(فرق ±D)» تُلحق دائماً — حتى مع ملاحظات مخصّصة — لأن quantity تُخزَّن
  // مطلقة والاتجاه يُسترجَع منها (مثلاً تصحيح netAfter في خدمة الجرد). لا تحذفها.
  const signMarker = `(فرق ${delta >= 0 ? "+" : ""}${delta})`;
  const res = await tx.insert(inventoryMovements).values({
    variantId: a.variantId,
    branchId: a.branchId,
    movementType: "ADJUST",
    quantity: Math.abs(delta),
    referenceType: a.referenceType ?? "ADJUST",
    referenceId: a.referenceId,
    notes: a.notes
      ? `${a.notes} — ${signMarker}`
      : `تسوية: من ${currentQty} إلى ${a.targetQuantity} ${signMarker}`,
    createdBy: a.createdBy,
  });
  await tx
    .insert(branchStock)
    .values({ variantId: a.variantId, branchId: a.branchId, quantity: a.targetQuantity })
    .onDuplicateKeyUpdate({ set: { quantity: a.targetQuantity } });
  return { movementId: extractInsertId(res), newQuantity: a.targetQuantity };
}

export interface TransferArgs {
  variantId: number;
  fromBranchId: number;
  toBranchId: number;
  baseQuantity: number;
  referenceType?: string;
  referenceId?: number;
  notes?: string;
  createdBy?: number;
}

/** Move stock between branches as two linked movements; deterministic lock order. */
export async function transferBetweenBranches(tx: Tx, a: TransferArgs) {
  if (a.fromBranchId === a.toBranchId) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن التحويل لنفس الفرع" });
  }
  // Lock both branch rows in ascending branchId order to avoid deadlocks.
  const [lo, hi] = [a.fromBranchId, a.toBranchId].sort((x, y) => x - y);
  await tx
    .select({ id: branchStock.id })
    .from(branchStock)
    .where(and(eq(branchStock.variantId, a.variantId), eq(branchStock.branchId, lo)))
    .for("update")
    .limit(1);
  await tx
    .select({ id: branchStock.id })
    .from(branchStock)
    .where(and(eq(branchStock.variantId, a.variantId), eq(branchStock.branchId, hi)))
    .for("update")
    .limit(1);

  const out = await applyMovement(tx, {
    variantId: a.variantId,
    branchId: a.fromBranchId,
    baseQuantity: a.baseQuantity,
    movementType: "TRANSFER_OUT",
    relatedBranchId: a.toBranchId,
    referenceType: a.referenceType ?? "TRANSFER",
    referenceId: a.referenceId,
    notes: a.notes,
    createdBy: a.createdBy,
  });
  const inn = await applyMovement(tx, {
    variantId: a.variantId,
    branchId: a.toBranchId,
    baseQuantity: a.baseQuantity,
    movementType: "TRANSFER_IN",
    relatedBranchId: a.fromBranchId,
    referenceType: a.referenceType ?? "TRANSFER",
    referenceId: a.referenceId,
    notes: a.notes,
    createdBy: a.createdBy,
  });
  return { from: out, to: inn };
}
