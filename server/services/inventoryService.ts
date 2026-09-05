import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";
import { branchStock, inventoryMovements, openingModeSettings, productUnits, productVariants, products } from "../../drizzle/schema";
import { appErrorMessage } from "@shared/errors";
import { variantDisplayName } from "@shared/variantDisplay";
import type { Tx } from "../db";
import type { DecimalInput } from "./money";
import { extractInsertId } from "../lib/insertId";
import { loadVariantAvailability } from "./catalog/variantAvailability";
import { lockInventoryVariants } from "./inventory/stockLock";
import { assertPeriodOpen } from "./periodLockService";

export { ensureBranchStockRows } from "./inventory/stockLock";

/**
 * اسمُ الصنف كما يعرفه الموظّف — تُقرأ **في مسار الرفض وحده**.
 *
 * «المخزون غير كافٍ: المتاح 0، المطلوب 3» رقمان بلا هويّة: الكاشير أمام زبونٍ واقف لا يعرف
 * أيَّ سطرٍ من سلّته سقط، فيفتح شاشةً أخرى ليخمّن. الاسمُ هو ما يحوّل الرسالة إلى فعل.
 * والصيغة من `@shared/variantDisplay` كي لا ينجرف اسمُ الصنف في الرفض عن اسمه في الشاشة.
 *
 * تتحمّل غياب الصفّ فتعود إلى رقم المتغيّر: رسالةُ الرفض لا يصحّ أن تسقط هي نفسها.
 */
async function describeVariantForMessage(tx: Tx, variantId: number): Promise<string> {
  const rows = await tx
    .select({
      productName: products.name,
      variantName: productVariants.variantName,
      variantKind: productVariants.variantKind,
      color: productVariants.color,
      size: productVariants.size,
      sku: productVariants.sku,
    })
    .from(productVariants)
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(eq(productVariants.id, variantId))
    .limit(1);
  const row = rows[0];
  return row ? variantDisplayName(row) : `الصنف رقم ${variantId}`;
}

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

/**
 * «يُباع بالطلب» (0318): صنفٌ مخزنيّ مسموحٌ بيعُه **قبل** توريده، ورصيدُه السالب عدّادُ التزامٍ
 * يعود صفراً بأوّل شراءٍ (فاتورة مورّد) أو إنتاجٍ داخليّ يُغطّيه.
 *
 * ⚠️ الإعفاء **دائم** بقصد: البديلان القائمان كلاهما ينكسر في الدورة الثانية —
 *  • `allowNegativeUnopened` مشروطٌ بـ`openedAt IS NULL`، وأوّل استلامٍ يَسِم الصنف مُفتتَحاً
 *    (`stampOpened`) فيعود الرفض؛
 *  • و«وضع الافتتاح» مفتاحٌ عامّ بنافذة ≤٦٠ يوماً ونقديٍّ كامل — أداةُ ترحيلٍ لا سياسةَ تشغيل.
 * والصفة هنا حقيقةُ عملٍ دائمة عن الصنف، فمكانها صفُّ المنتج لا لحظةٌ ولا مفتاحٌ عامّ.
 */
export async function isBackorderVariant(tx: Tx, variantId: number): Promise<boolean> {
  const rows = await tx
    .select({ allowBackorder: products.allowBackorder })
    .from(productVariants)
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(eq(productVariants.id, variantId))
    .limit(1);
  return !!rows[0]?.allowBackorder;
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
 *  موجبةً والاتجاه من النوع: IN/RETURN/TRANSFER_IN=+، OUT/TRANSFER_OUT=−، وADJUST من علامة النص.
 *
 *  ⭐ P1-#3 (٢٥/٨): يفضّل الآن `signedDelta` المخزَّن على العمود إن تُوفَّر (writers جدد يعبّئونه؛
 *  Backfill 0265 عبّأ القديم). الاشتقاقُ من النوع/النصّ يبقى fallback للحالة القصوى (صفٌّ قديم جداً
 *  بلا notes مطابق للpattern). القرّاء الجدد الذين يبنون تقارير SQL يستعملون `signedDelta` مباشرةً
 *  (`SUM(signedDelta)`) بلا JS، ثمّ يتحقّقون من الصفوف NULL على حدة.
 */
export function signedMoveQty(
  movementType: string,
  quantity: number,
  notes: string | null,
  signedDelta?: number | null,
): number {
  if (signedDelta != null) return signedDelta;
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


/**
 * حارس إقفال الفترة على المخزون (تدقيق ٢٧/٧، H5).
 *
 * كان `assertPeriodOpen` يُستدعى من `postEntry` (وفتحِ الرصيد الافتتاحيّ) فقط — أي أنّ الفترة
 * المقفلة تحرس **الدفتر** ولا تحرس **المخزون**. والفارق ليس نظرياً: أصل المخزون في الميزانية
 * يُقرأ **حيّاً** (`SUM(quantity × costPrice)`) بلا تاريخٍ مرجعيّ، فأيّ حركةِ مخزونٍ بعد الإقفال
 * تُغيّر **ميزانيةَ الفترة المقفلة نفسها** بأثرٍ رجعيّ: تنحرف عن الأرباح المحتجزة المُرحَّلة،
 * وتصير غير قابلةٍ لإعادة الإنتاج. وأخطر ما فيه أنّه صامت — لا رفض ولا تنبيه.
 *
 * الحركاتُ التي ترافقها قيود (بيع/شراء/مرتجع/تسوية معتمَدة) كانت محروسةً عرَضاً عبر `postEntry`؛
 * أمّا **التحويل بين الفروع** و**التثبيت الافتتاحيّ** وكل مسارٍ لا يُرحّل قيداً فكانت تمرّ.
 *
 * التاريخ المُحتكَم إليه هو **الآن**: الرصيد كمّيةٌ حيّة لا سلسلةٌ مؤرَّخة، فتغييرُه اليوم يغيّر
 * قيمة كل تاريخٍ سابق. ⇒ يُرفَض متى كان اليوم داخل الفترة المقفلة.
 *
 * لا كلفة قفلٍ إضافية: `withTx` يأخذ `lockFinancialPostingGate` (قفل مشترك) عند دخول كل معاملة،
 * فالقراءة هنا مُسلسَلةٌ مع الإقفال بنفس ترتيب `postEntry`.
 */
async function assertInventoryPeriodOpen(tx: Tx): Promise<void> {
  await assertPeriodOpen(tx, new Date());
}

/** Read current stock under a row lock, then write a movement + the new branchStock. */
export async function applyMovement(tx: Tx, a: ApplyMovementArgs): Promise<ApplyMovementResult> {
  if (!Number.isInteger(a.baseQuantity) || a.baseQuantity <= 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّرت حركة المخزون",
        why: `الكمية الأساس يجب أن تكون عدداً صحيحاً موجباً، والمُرسَل ${a.baseQuantity}`,
        doThis: "أدخِل كمّيةً موجبة تُنتج عدداً صحيحاً بالوحدة الأساس، أو اختر وحدةً بمعامل تحويلٍ يقبل كسر الكمية",
      }),
    });
  }
  await lockInventoryVariants(tx, [a.variantId]);

  // مُنتج خِدمي: لا تَتبُّع مَخزون. التَحويل بين الفُروع مَمنوع منطقياً (الخَدمة لا تُحَوَّل
  // كَأنها بِضاعة). البَيع/الشِراء/المُرتجَع/التَسوية: نَخرج بِنَتيجة اصطناعية بِلا حركة ولا
  // كِتابة على branchStock. الإيراد/التَكلفة يَستمرّ عَبر مَسارات أخرى (saleService، COGS).
  if (await isServiceVariant(tx, a.variantId)) {
    if (a.movementType === "TRANSFER_IN" || a.movementType === "TRANSFER_OUT") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: `تعذّر تحويل «${await describeVariantForMessage(tx, a.variantId)}» بين الفرعين`,
          why: "الصنف خِدميّ (بلا مخزون) — والخدمة تُقدَّم في كل فرعٍ ولا تُنقَل كالبضاعة",
          doThis: "أزِل السطر الخِدميّ من التحويل وأرسِل البضاعة وحدها؛ وإن كان تصنيفه خطأً فصحّحه من صفحة تعديل المنتج",
        }),
      });
    }
    return { movementId: 0, newQuantity: 0 };
  }

  // bundles: البكج بلا branchStock — يجب أن يُوسَّع لمكوّناته قبل الوصول لهنا (sale/create.ts + returnService).
  // أي استدعاء مباشر خطأ برمجيّ (شراء بكج، تحويل بكج، جرد بكج) — نمنعه صراحةً برسالةٍ تدلّ على السبب.
  if (await isBundleVariant(tx, a.variantId)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: `تعذّرت حركة مخزونٍ مباشرة على «${await describeVariantForMessage(tx, a.variantId)}»`,
        why: "الصنف بكج (مركَّب) — لا رصيد له بذاته، ورصيدُه هو رصيد مكوّناته",
        doThis: "حرّك مكوّنات البكج بدلاً منه (شراءً أو تحويلاً أو جرداً)، وراجع وصفته من صفحة تعديل المنتج",
      }),
    });
  }

  // بعد المخارج التي لا تكتب شيئاً (الخِدميّ يعود، والبكج يرمي) وقبل أوّل كتابة: فترةٌ مقفلة
  // تعني أنّ قيمة المخزون في ميزانيتها نهائية — فلا تُمَسّ الكمّية التي تُشتقّ منها.
  await assertInventoryPeriodOpen(tx);

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

  // اضمن وجود صفّ الرصيد بعد mutex المتغيّر، ثم اقفله.
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
  const unopenedAllowed = a.allowNegativeUnopened === true && rows[0]?.openedAt == null;
  // «يُباع بالطلب» (0318): إعفاءٌ **دائم** لصنفٍ وُسِم كذلك — رصيدُه السالب عدّادُ التزامٍ مقصود
  // (مُباعٌ لم يُورَّد) يعود صفراً بأوّل شراءٍ أو إنتاجٍ يُغطّيه.
  // القراءة **كسولة ومحفوظة**: لا تُدفَع إلّا حين يوشك حارسٌ على الرفض فعلاً — فالبيع المكتفي
  // المخزون (الغالبية العظمى) لا يدفع أيّ استعلامٍ إضافيّ — وتُقرأ مرّةً واحدة لا مرّةً لكلّ حارس.
  let backorderCache: boolean | null = null;
  const isBackorder = async (): Promise<boolean> => {
    if (a.allowNegative || unopenedAllowed) return false; // مسموحٌ سلفاً — لا حاجة للقراءة.
    if (backorderCache == null) backorderCache = await isBackorderVariant(tx, a.variantId);
    return backorderCache;
  };

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
  // «يُباع بالطلب» يعبر حاجز الحجوزات أيضاً — وإلّا بقي الصنف محجوباً كلّما وُجد حجزٌ قائم،
  // وهو نقيض معنى الصفة: الطلب المحجوز يُغطّى من التوريد التالي كما يُغطّى البيع الجديد.
  if (
    DEDUCTING.has(a.movementType) &&
    reservedBase > 0 &&
    a.baseQuantity > availableAfterAllocations &&
    a.allowNegative !== true &&
    !(await isBackorder())
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: `رصيد «${await describeVariantForMessage(tx, a.variantId)}» في هذا الفرع محجوزٌ لطلبٍ آخر`,
        why:
          `المتاح بعد الحجوزات وطلبات المتجر ${availableAfterAllocations} وحدة أساس، ` +
          `والمطلوب ${a.baseQuantity} — لا يمكن استهلاك مخزون مخصّص لطلب آخر`,
        // المخرج الأوّل وحده يملكه الكاشير؛ والآخران محجوبان بالدور (التحويلات
        // `inventoryWarehouseProcedure`) ⇒ يُصاغان إحالةً لا أمراً، وإلّا وقف مَن لا يملكهما.
        doThis:
          `أنقص الكمية إلى ${availableAfterAllocations} وحدة أساس، ` +
          "أو اطلب فكّ الحجز من الطلب الذي يحمله، " +
          "أو اطلب من أمين المخزن تحويل الفرق من فرعٍ آخر ثمّ أعِد المحاولة",
      }),
    });
  }

  const sign = SIGN[a.movementType];
  const backorderAllowed =
    DEDUCTING.has(a.movementType) && currentQty < a.baseQuantity && (await isBackorder());
  const negativeAllowed = a.allowNegative || unopenedAllowed || backorderAllowed;
  if (DEDUCTING.has(a.movementType) && currentQty < a.baseQuantity && !negativeAllowed) {
    // ⚠️ «المخزون غير كافٍ» **جزءٌ متعاقَد عليه** من هذا النصّ: `sale/create.ts` و`workOrder/lifecycle.ts`
    // يُثريان الرفضَ بسبب وضع الافتتاح حين تطابقه، و`Reception.tsx` يفتح به تأكيد البيع بالسالب.
    // أعِد صياغة ما شئت حولها — ولا تُسقِطها، فإسقاطها يُعطّل ثلاثة مسارات في ملفّاتٍ أخرى بصمت.
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: `المخزون غير كافٍ لصرف «${await describeVariantForMessage(tx, a.variantId)}» من هذا الفرع`,
        why: `المتاح ${currentQty} وحدة أساس والمطلوب ${a.baseQuantity}`,
        // ثلاثةُ قيودٍ على هذا المخرج، كلٌّ منها أمسكته مراجعةٌ عدائية بعد أوّل صياغة:
        //   ① الرصيد قد يكون سالباً أصلاً (بيعٌ سابق بالسالب) ⇒ «أنقص الكمية إلى -5» لا تُنفَّذ.
        //   ② **الوحدة تُسمّى في الأمر لا في السبب وحده**: `currentQty` وحدةُ أساس، وسطرُ البيع
        //      يمرّ بـ`convertToBaseQuantity` ⇒ الكاشير يُدخل بالوحدة المختارة. «أنقص إلى 7»
        //      على سطرٍ بالدرزن تُقرأ «7 درزن» = 84 أساساً فيسقط ثانيةً — والأمرُ هو المُنفَّذ.
        //   ③ **مَن يقرأ ليس مَن يستطيع**: التحويلات محجوبةٌ بـ`inventoryWarehouseProcedure`
        //      و«يُباع بالطلب» بـ`productsManagerProcedure` ⇒ للكاشير صفرُ مخرجٍ منفَّذ. صيغةُ
        //      الإحالة تُعيد له فعلاً يملكه: أن يطلب. و«يُباع بالطلب» ممنوعٌ بنيوياً على
        //      الأمانة والخدمة والبكج (`chk_product_backorder_stocked_only`) — فيُقيَّد بالمملوك.
        doThis:
          (currentQty > 0 ? `أنقص الكمية إلى ${currentQty} وحدة أساس، أو ` : "") +
          "اطلب من أمين المخزن تحويل الكمية من فرعٍ آخر (المخزون ← التحويلات)، " +
          "أو اطلب من المدير تفعيل «يُباع بالطلب» على المنتج إن كان مملوكاً ويُورَّد بالطلب، " +
          "ثمّ أعِد المحاولة",
      }),
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
  // وسمُ الحركة صراحةً: سالبُ «يُباع بالطلب» مقصودٌ ويجب أن يُقرأ كذلك في كشف الحركة، وإلّا
  // بدا في المراجعة كعجزٍ مخزنيّ مجهول السبب — وهو أكثر ما يُهدر وقت المدقّق.
  if (backorderAllowed) {
    notes = `${a.notes ? `${a.notes} — ` : ""}[بيع بالطلب: بانتظار التوريد بشراءٍ أو إنتاج]`;
  }
  if (DEDUCTING.has(a.movementType) && negativeAllowed && newQuantity < 0) {
    const cap = await readNegativeFloorCap(tx);
    if (newQuantity < -cap) {
      // «يُباع بالطلب» يُوسَم ولا يُرفَض — نظير allowNegative تماماً. الرفض هنا كان سيُعيد
      // نصبَ الحاجز الذي وُجدت الصفة لإزالته، وفي أسوأ لحظة: بعد أن التزم الموظّف للزبون.
      if (!a.allowNegative && !backorderAllowed) {
        // ⚠️ «البيع بالسالب في وضع الافتتاح» متعاقَدٌ عليه أيضاً: `negativeStockFloorGuard.test.ts`
        // يطابقه، و`Reception.tsx` يشترط «الافتتاح» ليفتح تأكيد التوفّر الفيزيائيّ.
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: `بلغ «${await describeVariantForMessage(tx, a.variantId)}» حدّ البيع بالسالب في وضع الافتتاح`,
            why: `الحدّ ${cap} وحدة أساس، والرصيد سيصبح ${newQuantity}`,
            doThis:
              "اعتمد جرداً افتتاحياً يثبّت رصيده الحقيقي (المخزون ← الجرد) ثمّ أعِد بيعه، " +
              "أو ورِّد الصنف بشراءٍ يرفع رصيده فوق الحدّ",
          }),
        });
      }
      floorBreached = true;
      notes = `${notes ? `${notes} — ` : ""}[تجاوز حدّ السالب: الرصيد ${newQuantity} دون ‑${cap}]`;
    }
  }

  const res = await tx.insert(inventoryMovements).values({
    variantId: a.variantId,
    branchId: a.branchId,
    movementType: a.movementType,
    quantity: a.baseQuantity,
    // ⭐ P1-#3: `signedDelta` = نفس `signedDelta` المطبَّق على `branchStock` أعلاه. يجعل تقارير
    // المطابقة SQL خامّاً ممكنة (`SUM(signedDelta)` بلا JS). الاتّساقُ محفوظ: كلاهما مصدرٌ واحد.
    signedDelta: signedDelta,
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
    // `unitName` للرسالة وحدها: «وحدة المنتج معطّلة» بلا اسمِ الوحدة تُجبر الموظّف على تخمين
    // أيَّ وحدةٍ من وحدات الصنف يقصد النظام (قطعة/درزن/كرتون) قبل أن يعرف ما يُصلحه.
    .select({
      factor: productUnits.conversionFactor,
      isBase: productUnits.isBaseUnit,
      isActive: productUnits.isActive,
      variantId: productUnits.variantId,
      unitName: productUnits.unitName,
    })
    .from(productUnits)
    .where(eq(productUnits.id, productUnitId))
    .limit(1);
  const u = rows[0];
  if (!u) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: appErrorMessage({
        what: "تعذّر تحويل الكمية إلى الوحدة الأساس",
        why: `وحدة المنتج رقم ${productUnitId} غير موجودة — يبدو أنها حُذفت بعد فتح الشاشة`,
        doThis: "أعِد تحميل الشاشة واختر وحدةً من قائمة وحدات الصنف الحالية",
      }),
    });
  }
  if (variantId !== undefined && Number(u.variantId) !== variantId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: `تعذّر استعمال وحدة «${u.unitName}» مع هذا الصنف`,
        why: `الوحدة تخصّ صنفاً آخر (رقم ${Number(u.variantId)}) لا الصنف المُرسَل (رقم ${variantId})`,
        doThis: "أعِد اختيار الصنف ثمّ وحدته من القائمة نفسها — لا تنسخ سطراً من صنفٍ إلى آخر",
      }),
    });
  }
  if (u.isActive === false) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: `وحدة «${u.unitName}» معطّلة`,
        why: "الوحدة المعطّلة لا تُستعمَل في حركةٍ جديدة، وقد عُطِّلت بعد فتح هذه الشاشة",
        doThis: "اختر وحدةً فعّالة للصنف، أو أعِد تفعيل هذه الوحدة من صفحة تعديل المنتج",
      }),
    });
  }
  const q = new Decimal(quantity);
  const f = new Decimal(u.factor);
  if (q.lte(0)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر تحويل الكمية إلى الوحدة الأساس",
        why: `الكمية يجب أن تكون موجبة، والمُدخَل ${q.toString()}`,
        doThis: "أدخِل كمّيةً أكبر من صفر؛ ولحذف السطر استعمل زرّ الحذف لا الكمّية الصفرية",
      }),
    });
  }
  if (f.lte(0)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: `معامل تحويل وحدة «${u.unitName}» غير صالح`,
        why: `المعامل يجب أن يكون أكبر من صفر، والمخزَّن ${f.toString()}`,
        doThis: "صحّح معامل التحويل للوحدة من صفحة تعديل المنتج (كم وحدة أساس فيها) ثمّ أعِد المحاولة",
      }),
    });
  }
  const base = q.mul(f);
  if (!base.isInteger()) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر تحويل الكمية إلى الوحدة الأساس",
        why: `${q.toString()} × معامل وحدة «${u.unitName}» (${f.toString()}) = ${base.toString()}، وهو ليس عدداً صحيحاً — والمخزون يُمسَك بالوحدة الأساس صحيحاً`,
        doThis: "قرّب الكمية إلى ما يُنتج عدداً صحيحاً، أو أدخِلها بالوحدة الأساس مباشرةً، أو صحّح معامل التحويل من صفحة تعديل المنتج",
      }),
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
   * اعتماد جرد حصراً — افتتاحيّ أو دوريّ على حدٍّ سواء (١٨/٧، وُحِّد المساران ٤/٩): يسمح بهدفٍ
   * سالب — صنفٌ عُدّ ثم بِيع بالسالب أكثر من عدّه قبل الاعتماد يُثبَّت برصيده السالب الحقيقي
   * (فيُفتتَح إن لم يكن ويتحوّل فوراً للصرامة، ويظهر في تقرير السوالب) بدل حجب اعتماد الجلسة
   * كلّها بصنفٍ واحد (علّة livelock — مراجعة عدائية ١٨/٧؛ كانت مقصورةً على الافتتاحي وحده حتى
   * ٤/٩ فتكرّرت على جلساتٍ دوريّة بأصنافٍ سريعة البيع). لا تستعمله لغير مسار اعتماد الجرد.
   */
  allowNegativeTarget?: boolean;
}

/** Absolute stock adjustment (ADJUST). Records abs(delta) and the direction in notes. */
export async function setStock(tx: Tx, a: SetStockArgs): Promise<ApplyMovementResult> {
  if (!Number.isInteger(a.targetQuantity) || (a.targetQuantity < 0 && !a.allowNegativeTarget)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّرت تسوية الرصيد",
        why: `الرصيد المستهدف يجب أن يكون عدداً صحيحاً غير سالب، والمُرسَل ${a.targetQuantity}`,
        doThis: "أدخِل العدد المعدود فعلياً بالوحدة الأساس (صفر إن لم يبقَ منه شيء)؛ والرصيد السالب لا يُثبَّت إلّا بجردٍ افتتاحيّ",
      }),
    });
  }
  await lockInventoryVariants(tx, [a.variantId]);
  // مُنتج خِدمي: لا تَسوية مَخزون لـ«ما لا مَخزون له». نَتجاهل بِنَتيجة اصطناعية.
  if (await isServiceVariant(tx, a.variantId)) {
    return { movementId: 0, newQuantity: 0, delta: 0 };
  }
  // bundles: لا تسوية جرد مباشرة للبكج — الجرد يفحص مكوّناته. رفض صريح لا تجاهُل صامت.
  if (await isBundleVariant(tx, a.variantId)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: `تعذّرت تسوية رصيد «${await describeVariantForMessage(tx, a.variantId)}»`,
        why: "الصنف بكج (مركَّب) لا رصيد له بذاته — رصيدُه محسوبٌ من مكوّناته",
        doThis: "سوِّ مكوّنات البكج واحداً واحداً، ويعود رصيد البكج صحيحاً من تلقائه",
      }),
    });
  }
  // `setStock` يكتب حركته وصفَّه بنفسه (لا يمرّ بـapplyMovement) ⇒ يلزمه الحارس صراحةً.
  await assertInventoryPeriodOpen(tx);
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
    // ⭐ P1-#3: نُخزّن الدلتا الموقَّعة مباشرةً — تُطابق `signMarker` النصّيّ (يبقى لأنّه يظهر للمستخدم)
    // لكنّها الآن مستقلّةٌ عن Parsing النصّ في القرّاء الجدد. لو تعطّل نمطُ الوسم مستقبلاً، القارئُ
    // يعتمد على العمود لا النصّ.
    signedDelta: delta,
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
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر تنفيذ التحويل",
        why: `فرع المصدر وفرع الوجهة واحد (رقم ${a.fromBranchId}) — والتحويل نقلُ رصيدٍ بين فرعين`,
        doThis: "اختر فرع وجهةٍ مختلفاً؛ ولتصحيح رصيدٍ داخل الفرع نفسه استعمل تسوية المخزون لا التحويل",
      }),
    });
  }
  await lockInventoryVariants(tx, [a.variantId]);
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
