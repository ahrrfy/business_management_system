import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";
import { branchStock, inventoryMovements, openingModeSettings, productUnits, productVariants, products } from "../../drizzle/schema";
import type { Tx } from "../db";
import type { DecimalInput } from "./money";
import { extractInsertId } from "../lib/insertId";
import { loadVariantAvailability } from "./catalog/variantAvailability";

/** يَتحقّق إن كان المُتغيّر يَنتمي لمُنتج خِدمي (لا مَخزون). يُستعمَل لِتجاوز inventoryMovements/branchStock. */
export async function isServiceVariant(tx: Tx, variantId: number): Promise<boolean> {
  const rows = await tx
    .select({ isService: products.isService })
    .from(productVariants)
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(eq(productVariants.id, variantId))
    .limit(1);
  return !!rows[0]?.isService;
}

/** bundles (٧/٧/٢٦): يتحقّق إن كان المتغيّر يخصّ منتج بكج (لا branchStock له — يُوسَّع لمكوّناته).
 *  استُدعي كحاجز دفاعي على applyMovement كي لا يُعبَّى صفّ رصيدٍ وهميّ للبكج (تدوين خطأ خفيّ في التقارير). */
export async function isBundleVariant(tx: Tx, variantId: number): Promise<boolean> {
  const rows = await tx
    .select({ isBundle: products.isBundle })
    .from(productVariants)
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(eq(productVariants.id, variantId))
    .limit(1);
  return !!rows[0]?.isBundle;
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
  /**
   * «وضع الافتتاح» (ش٢، ١٩/٧): يسمح بالنزول تحت الصفر **فقط إذا كان الصنف غير مُفتتَح**
   * (branchStock.openedAt IS NULL) — يُفحص تحت قفل FOR UPDATE نفسه فلا سباق مع اعتماد جرد
   * افتتاحي متزامن (يختم openedAt فيقفل السالب فوراً). مستقلّ تماماً عن allowNegative
   * (استهلاكيات الطباعة/إعادة تشغيل الأوفلاين — يبقيان بلا شرط openedAt).
   */
  allowNegativeUnopened?: boolean;
  /**
   * ختم `openedAt` بعد الحركة (COALESCE — مرّة واحدة) عند دخول رصيد موثَّق من استلام شراء أو إيداع
   * أمانة. كلاهما «افتتاحٌ» فعلي للرصيد في الفرع، فلا يُترَك الصنف قابلاً للبيع بالسالب أو للجرد
   * الافتتاحي بعد ذلك. يطابق فرع OPENING في setStock.
   */
  stampOpened?: boolean;
  /**
   * استثناء تخصيص طلب المتجر الجاري فقط عند تحويله إلى فاتورة. يبقى reservationStock
   * وكل طلب نشط آخر محمياً تحت mutex المتغيّر/الرصيد نفسه. حقل داخلي لا تقبله الراوترات.
   */
  onlineOrderAllocationExemptionId?: number;
  /**
   * مجموع الحجز الرسمي الجاري + الحجوزات الأحدث منه المسموح بتجاوزها وفق FIFO، بوحدة الأساس.
   * يُطرح من formalReservationBase وحده (وبحدّه)، فلا يعفي حجزاً أقدم ولا تخصيص طلب إلكتروني.
   */
  formalReservationExemptionBase?: number;
}
export interface ApplyMovementResult {
  movementId: number;
  newQuantity: number;
  /** فرق التسوية (target − current) — يملؤه setStock فقط ليُمكّن المستدعي من ترحيل قيدٍ محاسبيّ بقيمة الفرق. */
  delta?: number;
  /** رُفع حين سمحت قناة allowNegative (أوفلاين/مواد خدمات) بنزول الرصيد تحت أرضية السالب (‑cap) —
   *  للكشف/التنبيه دون رفض (لا يُسقَط بيعٌ حصل فعلاً). المسار الحيّ يُرفض بدل رفع العلَم. */
  floorBreached?: boolean;
}

/** أرضية السالب = openingModeSettings.maxNegativeQtyPerLine (صفّ singleton id=1)، والافتراض ١٠٠
 *  يطابق DEFAULTS في openingModeService. تُقرأ فقط عند نزول رصيدٍ مسموحٍ بالسالب تحت الصفر (نادر)
 *  ⇒ لا عبء على المسار الشائع (البيع المعتاد بلا سالب لا يستدعيها). */
async function readNegativeFloorCap(tx: Tx): Promise<number> {
  const rows = await tx
    .select({ cap: openingModeSettings.maxNegativeQtyPerLine })
    .from(openingModeSettings)
    .where(eq(openingModeSettings.id, 1))
    .limit(1);
  const cap = rows[0]?.cap;
  return typeof cap === "number" && cap > 0 ? cap : 100;
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

  // bundles: البكج بلا branchStock — يجب أن يُوسَّع لمكوّناته قبل الوصول لهنا (sale/create.ts + returnService).
  // أي استدعاء مباشر خطأ برمجيّ (شراء بكج، تحويل بكج، جرد بكج) — نمنعه صراحةً برسالةٍ تدلّ على السبب.
  if (await isBundleVariant(tx, a.variantId)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "لا يُمكن تحريك مخزون مباشرةً لمنتج بكج — البكج مركّب ومخزونه = مخزون مكوّناته",
    });
  }

  // حارس الخصم المركزي: كل قناة (POS/API/dispatch/transfer) ترى الحجز الرسمي وتخصيصات
  // الطلبات الإلكترونية تحت الأقفال نفسها. dispatch يستثني طلبه وحده، فلا يخصم حصة B
  // عند شحن A. allowNegative=true محجوز لوقائع خرجت فعلاً (offline/material consumption)
  // ويجب تسجيلها ولو كشفت عجزاً؛ المسارات الحيّة لا تتجاوز هذا الحارس.
  const lockedAvailability = DEDUCTING.has(a.movementType)
    ? (await loadVariantAvailability(tx, a.branchId, [a.variantId], {
        lock: true,
        excludeOnlineOrderId: a.onlineOrderAllocationExemptionId,
      })).get(a.variantId)
    : undefined;

  // اضمن وجود صفّ الرصيد قبل القفل — FOR UPDATE لا يقفل شيئاً على صفّ غير موجود (يتسرّب بيعٌ زائد/فقدُ تحديث).
  await tx
    .insert(branchStock)
    .values({ variantId: a.variantId, branchId: a.branchId, quantity: 0 })
    .onDuplicateKeyUpdate({ set: { variantId: sql`${branchStock.variantId}` } });

  const rows = await tx
    .select({ quantity: branchStock.quantity, openedAt: branchStock.openedAt })
    .from(branchStock)
    .where(and(eq(branchStock.variantId, a.variantId), eq(branchStock.branchId, a.branchId)))
    .for("update")
    .limit(1);
  const currentQty = rows[0]?.quantity ?? 0;
  // «وضع الافتتاح»: السماح المشروط يسري على غير المُفتتَح فقط — openedAt مقروء تحت نفس القفل
  // (صفٌّ يُنشأ الآن = غير مُفتتَح بداهةً؛ واعتمادُ جردٍ افتتاحي متزامن يتسلسل على هذا القفل).
  const negativeAllowed = a.allowNegative || (a.allowNegativeUnopened === true && rows[0]?.openedAt == null);

  const requestedFormalExemption = Number.isSafeInteger(a.formalReservationExemptionBase)
    && Number(a.formalReservationExemptionBase) > 0
    ? Number(a.formalReservationExemptionBase)
    : 0;
  const formalReservationExemption = Math.min(
    lockedAvailability?.formalReservationBase ?? 0,
    requestedFormalExemption,
  );
  const reservedBase = Math.max(0, (lockedAvailability?.reservedBase ?? 0) - formalReservationExemption);
  const availableAfterAllocations = Math.max(0, currentQty - reservedBase);
  if (
    DEDUCTING.has(a.movementType) &&
    reservedBase > 0 &&
    a.baseQuantity > availableAfterAllocations &&
    a.allowNegative !== true
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        `المتاح بعد الحجوزات وطلبات المتجر ${availableAfterAllocations} وحدة أساس، ` +
        `والمطلوب ${a.baseQuantity} — لا يمكن استهلاك مخزون مخصّص لطلب آخر`,
    });
  }

  const sign = SIGN[a.movementType];
  if (DEDUCTING.has(a.movementType) && currentQty < a.baseQuantity && !negativeAllowed) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `المخزون غير كافٍ: المتاح ${currentQty}، المطلوب ${a.baseQuantity}`,
    });
  }
  const signedDelta = sign * a.baseQuantity;
  const newQuantity = currentQty + signedDelta;

  // ── أرضية السالب التراكمية (تحقيق سوالب ١٢/٨) ───────────────────────────────────────────────
  // السقف (openingModeSettings.maxNegativeQtyPerLine) كان يُفحَص في sale/create على **كمية السطر**
  // وحدها ⇒ يحدّ الفاتورة الواحدة لا الرصيد الناتج، فبيوعٌ متتابعة كلٌّ ضمن السقف تحفر الرصيد بلا قاع
  // (‑172/‑177 حقيقية). هنا — نقطة الاختناق الوحيدة لكل القنوات — نفرض القاع على **الرصيد الناتج**:
  //   • المسار الحيّ (allowNegativeUnopened: كاشير/طلب/آجل): يُرفض تجاوز ‑cap ويُرفض بيعٌ إضافيّ لصنفٍ
  //     بلغ القاع سلفاً ⇒ يتوقف التراكم، والكاشير يُوجَّه لجردٍ افتتاحي يثبّت الرصيد الحقيقي.
  //   • مسار allowNegative (إعادة تشغيل الأوفلاين + مواد الطباعة/الخدمات): **لا يُرفض أبداً** — رفضُ
  //     إعادة تشغيلٍ أوفلاينيّ = فقدُ بيعٍ حصل فعلاً؛ نكتفي بوسم الحركة ورفع floorBreached للكشف.
  let notes = a.notes;
  let floorBreached = false;
  if (DEDUCTING.has(a.movementType) && negativeAllowed && newQuantity < 0) {
    const cap = await readNegativeFloorCap(tx);
    if (newQuantity < -cap) {
      if (!a.allowNegative) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            `بلغ الصنف حدّ البيع بالسالب في وضع الافتتاح (الحدّ ${cap} وحدة أساس، والرصيد سيصبح ${newQuantity}) — ` +
            `يلزم جردٌ افتتاحي يثبّت رصيده الحقيقي قبل متابعة بيعه`,
        });
      }
      floorBreached = true;
      notes = `${a.notes ? `${a.notes} — ` : ""}[تجاوز حدّ السالب: الرصيد ${newQuantity} دون ‑${cap}]`;
    }
  }

  const res = await tx.insert(inventoryMovements).values({
    variantId: a.variantId,
    branchId: a.branchId,
    movementType: a.movementType,
    quantity: a.baseQuantity,
    referenceType: a.referenceType,
    referenceId: a.referenceId,
    relatedBranchId: a.relatedBranchId,
    notes,
    createdBy: a.createdBy,
  });
  const movementId = extractInsertId(res);

  // كتابة نسبية تحت القفل: تشفى ذاتياً ولا تطمس تحديثاً متزامناً (بخلاف الكتابة المطلقة السابقة).
  // استلام الشراء/إيداع الأمانة: ختم openedAt ذرّياً مع تحديث الكمية (COALESCE — أول ختم فقط).
  await tx
    .update(branchStock)
    .set(
      a.stampOpened
        ? { quantity: sql`${branchStock.quantity} + ${signedDelta}`, openedAt: sql`COALESCE(${branchStock.openedAt}, NOW())` }
        : { quantity: sql`${branchStock.quantity} + ${signedDelta}` },
    )
    .where(and(eq(branchStock.variantId, a.variantId), eq(branchStock.branchId, a.branchId)));

  return { movementId, newQuantity, floorBreached };
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
  /**
   * «الجرد الافتتاحي» حصراً (١٨/٧): يسمح بهدفٍ سالب — صنفٌ عُدّ ثم بِيع بالسالب أكثر من عدّه قبل
   * الاعتماد يُفتتَح برصيده السالب الحقيقي (فيتحوّل فوراً للصرامة ويظهر في تقرير السوالب) بدل حجب
   * اعتماد الجلسة كلّها بصنفٍ واحد (علّة livelock — مراجعة عدائية ١٨/٧). لا تستعمله لغير هذا المسار.
   */
  allowNegativeTarget?: boolean;
}

/** Absolute stock adjustment (ADJUST). Records abs(delta) and the direction in notes. */
export async function setStock(tx: Tx, a: SetStockArgs): Promise<ApplyMovementResult> {
  if (!Number.isInteger(a.targetQuantity) || (a.targetQuantity < 0 && !a.allowNegativeTarget)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الرصيد المستهدف يجب أن يكون صحيحاً غير سالب" });
  }
  // مُنتج خِدمي: لا تَسوية مَخزون لـ«ما لا مَخزون له». نَتجاهل بِنَتيجة اصطناعية.
  if (await isServiceVariant(tx, a.variantId)) {
    return { movementId: 0, newQuantity: 0, delta: 0 };
  }
  // bundles: لا تسوية جرد مباشرة للبكج — الجرد يفحص مكوّناته. رفض صريح لا تجاهُل صامت.
  if (await isBundleVariant(tx, a.variantId)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "لا تُسوَّى مخزون بكجٍ مباشرةً — سوِّ مكوّناته",
    });
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

  // «الافتتاح التدريجي» (١٨/٧): تسوية بمرجع OPENING = تثبيت رصيدٍ افتتاحي ⇒ يُختَم openedAt مركزياً
  // هنا (مصدر حقيقة واحد يغطي إنشاء المنتج/الاستيراد/البذرة/الجرد الافتتاحي). COALESCE يصون تاريخ
  // الافتتاح الأول عند إعادة تشغيلٍ idempotent (البذرة) — الافتتاح مرّة واحدة لكل (صنف×فرع).
  // توسعة (تحقيق سوالب ١٢/٨): الجرد **الدوري** (مرجع STOCKTAKE) يختم openedAt أيضاً — «العدّ يفتتح
  // الصنف». قبلها كان الجرد الدوري يصحّح الكمية دون ختم openedAt، فيبقى الصنف «غير مُفتتَح» ويُباع
  // بالسالب رغم اعتماد جرده (السبب المباشر للحادثة). التصنيف المحاسبيّ (عجز/زيادة) يبقى مستقلّاً.
  if (a.referenceType === "OPENING" || a.referenceType === "STOCKTAKE") {
    await tx
      .update(branchStock)
      .set({ openedAt: sql`COALESCE(${branchStock.openedAt}, NOW())` })
      .where(and(eq(branchStock.variantId, a.variantId), eq(branchStock.branchId, a.branchId)));
  }
  return { movementId: extractInsertId(res), newQuantity: a.targetQuantity, delta };
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
  // بضاعة الأمانة (ش٤ تحسين): استلام تحويل صنف أمانة = عدٌّ مُطابَق ⇒ يُختَم openedAt في الفرع الوجهة،
  // وإلّا ظهر «غير مُفتتَح» زوراً (يُباع بالسالب أثناء نافذة الافتتاح) بعد انتقاله. الاستلام موقَّع سطرياً.
  const [cf] = await tx
    .select({ isConsign: products.isConsignment })
    .from(productVariants).innerJoin(products, eq(productVariants.productId, products.id))
    .where(eq(productVariants.id, a.variantId)).limit(1);
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
    stampOpened: !!cf?.isConsign,
  });
  return { from: out, to: inn };
}
