/**
 * «المُسنَد المطلوب توريده» — متابعة أصناف «يُباع بالطلب» (هجرة 0318) التي بيعت ولم تُورَّد.
 *
 * الشاشة تُجيب سؤالاً واحداً: **كم أطلب الآن؟** ولذلك لا تكتفي بعرض الرصيد السالب:
 *   المطلوب = |الرصيد السالب|  −  ما هو **قيد الشراء** فعلاً  =  الصافي المطلوب.
 *
 * ⚠️ «قيد الشراء» يشمل **المسوَّدة** (DRAFT) عمداً مع المُرسَل والمؤكَّد. استبعادُها كان يُظهر
 * حاجةً كاملةً لصنفٍ سبق أن جهّز له المديرُ أمرَ شراء ⇒ **طلبٌ مكرَّر للمورّد**، وهو الخطأ
 * الأغلى هنا. المستبعَد وحده ما انتهى أثره: RECEIVED (دخل الرصيد فرفع السالب أصلاً)
 * وCANCELLED. والعمود يُسمّى في الشاشة بما يشمله صراحةً كي لا يُقرأ «مُرسَل» فقط.
 *
 * ولا نظير له في الإنتاج الداخليّ: `productionOrders.status` لا يعرف إلّا CONFIRMED/CANCELLED
 * (الإنتاج لحظيّ يرفع الرصيد فوراً) ⇒ لا طابور إنتاجٍ معلّق يُطرَح. `canProduce` أدناه يقول
 * للمدير إن كان بوسعه صنعُه بدل شرائه، لا أنّ صنعاً جارياً.
 */
import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import {
  branchStock,
  branches,
  inventoryMovements,
  productUnits,
  productVariants,
  productionRecipes,
  products,
  purchaseOrderItems,
  purchaseOrders,
} from "../../../drizzle/schema";
import { getDb } from "../../db";
import { money, round2, toDbMoney } from "../money";

/** أوامر الشراء التي ما زال لها أثرٌ مرتقب على الرصيد. RECEIVED رفع الرصيد سلفاً، وCANCELLED لا أثر له. */
const OPEN_PO_STATUSES = ["DRAFT", "SENT", "CONFIRMED"] as const;

export interface BackorderShortfallRow {
  variantId: number;
  productId: number;
  productName: string;
  sku: string;
  variantName: string | null;
  branchId: number;
  branchName: string;
  /** اسم وحدة الأساس — كل الكميات أدناه بها (لا تحويل: الرصيد يُخزَّن بالأساس). */
  baseUnitName: string;
  /** الرصيد كما هو (سالبٌ دائماً في هذه القائمة) — لا نُخفي الإشارة. */
  quantity: number;
  /** |الرصيد| = مُباعٌ لم يُورَّد. */
  shortfallBase: number;
  /** المرتقب من أوامر شراءٍ مفتوحة (مسوَّدة/مُرسَل/مؤكَّد) على هذا الفرع. */
  onOrderBase: number;
  /** ما يلزم طلبه فعلاً بعد خصم المرتقب. صفرٌ ⇒ الحاجة مغطّاة وتنتظر الاستلام. */
  netNeededBase: number;
  /** آخر حركة خصمٍ على الصنف في هذا الفرع — «منذ متى والزبون ينتظر». */
  lastSaleAt: Date | null;
  /** له وصفةٌ نشطة ⇒ يمكن إنتاجه داخلياً بدل شرائه. */
  canProduce: boolean;
  /** تكلفة الوحدة وقيمة العجز — `null` لمن لا يملك رؤية التكلفة (يُحجب في الراوتر). */
  costPrice: string | null;
  shortfallValue: string | null;
}

export interface ListBackorderShortfallInput {
  /** null/undefined = كل الفروع (للأدمن)؛ رقم = فرع محدّد. العزل يفرضه الراوتر. */
  branchId?: number | null;
  /** false ⇒ تُحجب التكلفة والقيمة (نمط `listReorderAlerts`: لا تسريب هامشٍ لأدوار القراءة). */
  includeCost?: boolean;
  limit?: number;
  offset?: number;
}

export interface BackorderShortfallResult {
  rows: BackorderShortfallRow[];
  /** العدد الكامل ضمن نفس النطاق — يكشف الاقتطاع بدل لافتةٍ كاذبة عند تجاوز limit. */
  total: number;
  /** إجماليّ الصافي المطلوب و قيمة العجز عبر كل الصفوف (لا الصفحة وحدها). */
  totalNetNeededBase: number;
  totalShortfallValue: string | null;
}

export async function listBackorderShortfall(
  input: ListBackorderShortfallInput = {},
): Promise<BackorderShortfallResult> {
  const db = getDb();
  if (!db) return { rows: [], total: 0, totalNetNeededBase: 0, totalShortfallValue: input.includeCost ? "0.00" : null };
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 500);
  const offset = Math.max(input.offset ?? 0, 0);

  // النطاق: الصنف موسومٌ «يُباع بالطلب» ورصيدُه في هذا الفرع سالب. المنتج/المتغيّر المعطَّلان
  // **يبقيان ظاهرين** عمداً: تعطيلُ صنفٍ لا يُلغي التزاماً قائماً تجاه زبونٍ دفع، وإخفاؤه
  // يُسقِط الالتزام من الشاشة بلا أن يُسقطه من الواقع.
  const conds = [eq(products.allowBackorder, true), lt(branchStock.quantity, 0)];
  if (input.branchId != null) conds.push(eq(branchStock.branchId, input.branchId));
  const where = and(...conds);

  const [{ n: total } = { n: 0 }] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(branchStock)
    .innerJoin(productVariants, eq(productVariants.id, branchStock.variantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(where);

  const rows = await db
    .select({
      variantId: branchStock.variantId,
      productId: productVariants.productId,
      productName: products.name,
      sku: productVariants.sku,
      variantName: productVariants.variantName,
      branchId: branchStock.branchId,
      branchName: branches.name,
      quantity: branchStock.quantity,
      costPrice: productVariants.costPrice,
    })
    .from(branchStock)
    .innerJoin(productVariants, eq(productVariants.id, branchStock.variantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .innerJoin(branches, eq(branches.id, branchStock.branchId))
    .where(where)
    // الأعمق عجزاً أولاً (الرصيد تصاعدياً = الأصغر/الأسلب في الصدارة)، وكسرُ التعادل بمعرّف
    // الصفّ لترتيبٍ حتميّ يُبقي ترقيم الصفحات مستقرّاً.
    .orderBy(asc(branchStock.quantity), asc(branchStock.id))
    .limit(limit)
    .offset(offset);

  const variantIds = Array.from(new Set(rows.map((r) => Number(r.variantId))));

  // ── الإثراءات الثلاثة، كلٌّ باستعلامٍ واحد مجمَّع (لا N+1 على صفحةٍ من ٢٠٠ صفّ) ──
  const [onOrderRows, unitRows, recipeRows, lastSaleRows] = variantIds.length
    ? await Promise.all([
        db
          .select({
            variantId: purchaseOrderItems.variantId,
            branchId: purchaseOrders.branchId,
            pending: sql<number>`SUM(GREATEST(${purchaseOrderItems.baseQuantity} - COALESCE(${purchaseOrderItems.receivedBaseQuantity}, 0), 0))`,
          })
          .from(purchaseOrderItems)
          .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderItems.purchaseOrderId))
          .where(
            and(
              inArray(purchaseOrderItems.variantId, variantIds),
              inArray(purchaseOrders.status, [...OPEN_PO_STATUSES]),
            ),
          )
          .groupBy(purchaseOrderItems.variantId, purchaseOrders.branchId),
        db
          .select({ variantId: productUnits.variantId, unitName: productUnits.unitName })
          .from(productUnits)
          .where(and(inArray(productUnits.variantId, variantIds), eq(productUnits.isBaseUnit, true))),
        db
          .select({ outputVariantId: productionRecipes.outputVariantId })
          .from(productionRecipes)
          .where(
            and(inArray(productionRecipes.outputVariantId, variantIds), eq(productionRecipes.isActive, true)),
          ),
        db
          .select({
            variantId: inventoryMovements.variantId,
            branchId: inventoryMovements.branchId,
            lastAt: sql<Date>`MAX(${inventoryMovements.createdAt})`,
          })
          .from(inventoryMovements)
          .where(
            and(
              inArray(inventoryMovements.variantId, variantIds),
              inArray(inventoryMovements.movementType, ["OUT", "TRANSFER_OUT"]),
            ),
          )
          .groupBy(inventoryMovements.variantId, inventoryMovements.branchId),
      ])
    : [[], [], [], []];

  const key = (variantId: number, branchId: number) => `${variantId}:${branchId}`;
  const onOrderByKey = new Map(
    onOrderRows.map((r) => [key(Number(r.variantId), Number(r.branchId)), Number(r.pending ?? 0)]),
  );
  const unitByVariant = new Map(unitRows.map((r) => [Number(r.variantId), r.unitName]));
  const producible = new Set(recipeRows.map((r) => Number(r.outputVariantId)));
  const lastSaleByKey = new Map(
    lastSaleRows.map((r) => [key(Number(r.variantId), Number(r.branchId)), r.lastAt ?? null]),
  );

  const mapped: BackorderShortfallRow[] = rows.map((r) => {
    const variantId = Number(r.variantId);
    const branchId = Number(r.branchId);
    const quantity = Number(r.quantity);
    const shortfallBase = Math.abs(quantity);
    const onOrderBase = onOrderByKey.get(key(variantId, branchId)) ?? 0;
    const cost = money(r.costPrice ?? "0");
    return {
      variantId,
      productId: Number(r.productId),
      productName: r.productName,
      sku: r.sku,
      variantName: r.variantName,
      branchId,
      branchName: r.branchName,
      baseUnitName: unitByVariant.get(variantId) ?? "وحدة",
      quantity,
      shortfallBase,
      onOrderBase,
      netNeededBase: Math.max(0, shortfallBase - onOrderBase),
      lastSaleAt: lastSaleByKey.get(key(variantId, branchId)) ?? null,
      canProduce: producible.has(variantId),
      costPrice: input.includeCost ? toDbMoney(round2(cost)) : null,
      shortfallValue: input.includeCost ? toDbMoney(round2(cost.times(shortfallBase))) : null,
    };
  });

  // الإجماليّات على **كل** النطاق لا على الصفحة — رأسٌ يتغيّر بالتصفّح يكذب على قارئه.
  const [totals] = await db
    .select({
      shortfall: sql<string>`COALESCE(SUM(-${branchStock.quantity}), 0)`,
      value: sql<string>`COALESCE(SUM(-${branchStock.quantity} * ${productVariants.costPrice}), 0)`,
    })
    .from(branchStock)
    .innerJoin(productVariants, eq(productVariants.id, branchStock.variantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(where);

  // المرتقب عبر كل النطاق (لا الصفحة) كي يطابق «الصافي المطلوب» في الرأس مجموعَ الصفوف كلّها.
  const [pendingAll] = await db
    .select({
      pending: sql<string>`COALESCE(SUM(LEAST(GREATEST(${purchaseOrderItems.baseQuantity} - COALESCE(${purchaseOrderItems.receivedBaseQuantity}, 0), 0), -${branchStock.quantity})), 0)`,
    })
    .from(branchStock)
    .innerJoin(productVariants, eq(productVariants.id, branchStock.variantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .innerJoin(purchaseOrderItems, eq(purchaseOrderItems.variantId, branchStock.variantId))
    .innerJoin(
      purchaseOrders,
      and(
        eq(purchaseOrders.id, purchaseOrderItems.purchaseOrderId),
        eq(purchaseOrders.branchId, branchStock.branchId),
      ),
    )
    .where(and(where, inArray(purchaseOrders.status, [...OPEN_PO_STATUSES])));

  const totalShortfall = Number(totals?.shortfall ?? 0);
  const totalPending = Number(pendingAll?.pending ?? 0);
  return {
    rows: mapped,
    total: Number(total ?? 0),
    totalNetNeededBase: Math.max(0, totalShortfall - totalPending),
    totalShortfallValue: input.includeCost ? toDbMoney(round2(money(totals?.value ?? "0"))) : null,
  };
}
