/**
 * onlineOrderService — إنشاء/تتبّع طلب متجر الجوال (B2C — الدفع عند الاستلام).
 *
 * ⚠️ الأمان (نقاط فشل Antigravity التي نُغلقها):
 *  ① **لا انتحال مدير**: الطلب لا يُنشئ فاتورة ولا يمسّ الدفتر/المخزون ولا يحمل createdBy=userId.
 *     هو «طلبٌ» بحالة PENDING مربوطٌ بعميلٍ حقيقي (find-or-create بالهاتف) حتى يؤكّده الموظف.
 *  ② **السعر خادمي**: لا يُقبل أيّ سعر من العميل — يُقرأ سعر المفرد (RETAIL) من القاعدة لكل بند.
 *  ③ **التحقّق**: كل بند يجب أن يكون منتجاً فعّالاً غير خدمي بوحدة فعّالة ولها سعر مفرد.
 *  ④ **idempotency**: clientRequestId فريد ⇒ النقر المزدوج/إعادة المحاولة لا تُنشئ طلباً ثانياً.
 *  ⑤ **ذرّي**: كل ذلك داخل withTx — أيّ خطأ ⇒ ROLLBACK كامل.
 *
 * الأجرة = deliveryFeeFor(المحافظة) تقديرياً (يثبّتها الموظف عند الإسناد — شريحة ٤).
 */
import { TRPCError } from "@trpc/server";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  branchStock,
  customers,
  onlineOrderItems,
  onlineOrders,
  productPrices,
  productUnits,
  productVariants,
  products,
} from "../../drizzle/schema";
import { deliveryFeeFor, governorateById } from "@shared/governorates";
import { getDb } from "../db";
import { extractInsertId } from "../lib/insertId";
import { money, round2, sumMoney, toDbMoney, toDbQty } from "./money";
import { resolvePromotionForLine } from "./salesPromotionService";
import { resolveStorefrontBranchId } from "./storefrontService";
import { getStoreSettings } from "./storeAdmin/storeSettingsService";
import { withTx } from "./tx";

const RETAIL = "RETAIL" as const;

/** حبيبة اليوم المحلي (بغداد UTC+3) YYYY-MM-DD — لتطابق نافذة العروض مع العرض في الكتالوج. */
function todayYmdBaghdad(): string {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export interface OnlineOrderLineInput {
  productUnitId: number;
  quantity: number;
}

export interface CreateOnlineOrderInput {
  branchId?: number | null;
  customerName: string;
  customerPhone: string;
  governorate: string;
  addressText: string;
  latitude?: number | null;
  longitude?: number | null;
  notes?: string | null;
  lines: OnlineOrderLineInput[];
  clientRequestId?: string | null;
}

export interface CreateOnlineOrderResult {
  orderId: number;
  orderNumber: string;
  /** The server-resolved storefront branch; never supplied by the browser. */
  branchId: number;
  subtotal: string;
  deliveryFee: string;
  total: string;
  itemCount: number;
  idempotentReplay?: boolean;
}

/**
 * تطبيع رقم عراقي إلى صيغة E.164 قانونية واحدة (+964…) قبل استعماله في مفتاح القفل + البحث +
 * الإدراج (مراجعة عدائية ١٢/٧): بدونه «07701234567» و«+9647701234567» لنفس المشترك يعطيان مفتاحَي
 * قفل مختلفَين وتطابقَين مختلفَين ⇒ عميلان متكرّران. نُوحّدهما هنا فتتلاقى الصيغ على سجلّ واحد.
 */
export function normalizeStorePhone(raw: string): string {
  const trimmed = raw.trim();
  let s = trimmed.replace(/[\s\-()]/g, "");
  if (s.startsWith("00")) s = "+" + s.slice(2);
  if (s.startsWith("+")) {
    const digits = s.slice(1).replace(/\D/g, "");
    return digits ? "+" + digits : trimmed;
  }
  const digits = s.replace(/\D/g, "");
  if (!digits) return trimmed;
  if (digits.startsWith("964")) return "+" + digits;
  if (digits.startsWith("0")) return "+964" + digits.slice(1);
  return "+964" + digits;
}

/** طلب متجر جديد — server-priced، مُتحقَّق، idempotent، ذرّي. لا أثر مالي (PENDING فقط). */
export async function createOnlineOrder(input: CreateOnlineOrderInput): Promise<CreateOnlineOrderResult> {
  const gov = governorateById(input.governorate);
  if (!gov) throw new TRPCError({ code: "BAD_REQUEST", message: "المحافظة غير معروفة" });
  if (!input.lines.length) throw new TRPCError({ code: "BAD_REQUEST", message: "السلة فارغة" });
  const name = input.customerName.trim();
  const phone = normalizeStorePhone(input.customerPhone);
  if (!name) throw new TRPCError({ code: "BAD_REQUEST", message: "الاسم مطلوب" });
  if (!phone) throw new TRPCError({ code: "BAD_REQUEST", message: "رقم الهاتف مطلوب" });
  const address = input.addressText.trim();
  if (!address) throw new TRPCError({ code: "BAD_REQUEST", message: "العنوان مطلوب" });
  const requestedLineQuantities = new Map<number, number>();
  for (const line of input.lines) {
    const qty = Math.floor(line.quantity);
    if (!Number.isSafeInteger(line.productUnitId) || !Number.isFinite(qty) || qty <= 0) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "كمية أو منتج غير صحيح" });
    }
    requestedLineQuantities.set(line.productUnitId, (requestedLineQuantities.get(line.productUnitId) ?? 0) + qty);
  }
  const requestedShippingAddress = input.notes && input.notes.trim()
    ? `${address}\nملاحظة: ${input.notes.trim()}`
    : address;
  // المتجر مغلق مؤقتاً (إعداد الموظف) ⇒ لا يُقبل طلب (إنفاذ خادمي فوق حجب الواجهة).
  const storeSettings = await getStoreSettings();
  if (!storeSettings.isOpen) throw new TRPCError({ code: "BAD_REQUEST", message: "المتجر مغلق مؤقتاً — لا يمكن استلام الطلبات حالياً" });
  // A public order always targets the store branch configured by the business.
  // Never let a caller route an order to an arbitrary branch through the public API.
  const branchId = await resolveStorefrontBranchId();

  return withTx(async (tx) => {
    // ① idempotency: أعِد الطلب نفسه إن تكرّر المفتاح (بلا إنشاء ثانٍ).
    if (input.clientRequestId) {
      const existing = (
        await tx
          .select({
            id: onlineOrders.id,
            orderNumber: onlineOrders.orderNumber,
            branchId: onlineOrders.branchId,
            customerPhone: customers.phone,
            subtotal: onlineOrders.subtotal,
            shippingCost: onlineOrders.shippingCost,
            total: onlineOrders.total,
            governorate: onlineOrders.governorate,
            shippingAddress: onlineOrders.shippingAddress,
          })
          .from(onlineOrders)
          .innerJoin(customers, eq(onlineOrders.customerId, customers.id))
          .where(eq(onlineOrders.clientRequestId, input.clientRequestId))
          .limit(1)
      )[0];
      if (existing) {
        const existingLines = await tx
          .select({ productUnitId: onlineOrderItems.productUnitId, quantity: onlineOrderItems.quantity })
          .from(onlineOrderItems)
          .where(eq(onlineOrderItems.onlineOrderId, Number(existing.id)));
        const storedLineQuantities = new Map<number, number>();
        for (const line of existingLines) {
          const unitId = Number(line.productUnitId);
          storedLineQuantities.set(unitId, (storedLineQuantities.get(unitId) ?? 0) + Number(line.quantity));
        }
        const sameLines = storedLineQuantities.size === requestedLineQuantities.size
          && Array.from(requestedLineQuantities.entries()).every(([unitId, quantity]) => storedLineQuantities.get(unitId) === quantity);
        // A request key is a replay key, not an order-lookup key.  Reject every
        // mismatch to prevent a guessed/colliding key from exposing another order.
        if (
          normalizeStorePhone(existing.customerPhone ?? "") !== phone
          || existing.governorate !== input.governorate
          || existing.shippingAddress !== requestedShippingAddress
          || !sameLines
        ) {
          throw new TRPCError({ code: "CONFLICT", message: "رمز الطلب استُخدم لطلب مختلف — أعد تحميل السلة وحاول مجدداً" });
        }
        return {
          orderId: Number(existing.id),
          orderNumber: existing.orderNumber,
          branchId: Number(existing.branchId),
          subtotal: String(existing.subtotal),
          deliveryFee: String(existing.shippingCost),
          total: String(existing.total),
          itemCount: existingLines.length,
          idempotentReplay: true,
        };
      }
    }

    // ② تسعير خادمي + تحقّق لكل بند.
    const items: {
      variantId: number;
      productUnitId: number;
      quantity: number;
      baseQuantity: number;
      unitPrice: string;
      lineTotal: string;
    }[] = [];
    const requestedBaseByVariant = new Map<number, number>();
    const todayYmd = todayYmdBaghdad();
    for (const line of input.lines) {
      const qty = Math.floor(line.quantity);
      if (!Number.isFinite(qty) || qty <= 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "كمية غير صحيحة" });
      }
      const row = (
        await tx
          .select({
            productId: products.id,
            productName: products.name,
            categoryId: products.categoryId,
            productUnitId: productUnits.id,
            variantId: productVariants.id,
            conversionFactor: productUnits.conversionFactor,
            unitActive: productUnits.isActive,
            variantActive: productVariants.isActive,
            productActive: products.isActive,
            showInStore: products.showInStore,
            isService: products.isService,
            price: productPrices.price,
            stockQty: branchStock.quantity,
          })
          .from(productUnits)
          .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
          .innerJoin(products, eq(productVariants.productId, products.id))
          .leftJoin(
            productPrices,
            and(eq(productPrices.productUnitId, productUnits.id), eq(productPrices.priceTier, RETAIL))
          )
          .leftJoin(
            branchStock,
            and(eq(branchStock.variantId, productVariants.id), eq(branchStock.branchId, branchId))
          )
          .where(eq(productUnits.id, line.productUnitId))
          .limit(1)
      )[0];
      if (
        !row ||
        !row.productActive ||
        !row.showInStore ||
        row.isService ||
        !row.variantActive ||
        !row.unitActive ||
        row.price == null
      ) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "أحد المنتجات لم يعُد متاحاً — حدّث السلة" });
      }
      // مزامنة المخزون: لا يُطلَب صنفٌ غير متوفّر (يُخصَم المخزون فعلياً عند الإرسال — شريحة ٤).
      if (Number(row.stockQty ?? 0) <= 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `«${row.productName}» غير متوفّر حالياً` });
      }
      // العرض خادمياً (نفس محرّك الكتالوج/POS) ⇒ السعر المدفوع = السعر المعروض.
      const retail = round2(row.price);
      const promo = await resolvePromotionForLine(tx, {
        branchId,
        customerTier: RETAIL,
        productId: Number(row.productId),
        variantId: Number(row.variantId),
        categoryId: row.categoryId != null ? Number(row.categoryId) : null,
        unitPrice: retail.toFixed(2),
        lineAmount: retail.toFixed(2),
        hasContractPrice: false,
        todayYmd,
      });
      const discount = promo ? money(promo.discountForUnit) : money(0);
      const unitPrice = round2(retail.minus(discount).lt(0) ? money(0) : retail.minus(discount));
      const lineTotal = round2(unitPrice.times(qty));
      const baseQuantity = Number(money(qty).times(row.conversionFactor ?? 1).toFixed(0));
      const variantId = Number(row.variantId);
      const requestedBase = (requestedBaseByVariant.get(variantId) ?? 0) + baseQuantity;
      if (Number(row.stockQty ?? 0) < requestedBase) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `«${row.productName}» لا تتوفر منه الكمية المطلوبة حالياً` });
      }
      requestedBaseByVariant.set(variantId, requestedBase);
      items.push({
        variantId,
        productUnitId: Number(row.productUnitId),
        quantity: qty,
        baseQuantity,
        unitPrice: unitPrice.toFixed(2),
        lineTotal: lineTotal.toFixed(2),
      });
    }

    const subtotal = round2(sumMoney(items.map((i) => i.lineTotal)));
    let deliveryFee = round2(deliveryFeeFor(input.governorate));
    // توصيل مجاني (AOV): إن بلغ المجموع الفرعي عتبة الإعدادات ⇒ الأجرة صفر (إنفاذ خادمي).
    const freeThreshold = storeSettings.freeShippingThreshold ? money(storeSettings.freeShippingThreshold) : null;
    if (freeThreshold && freeThreshold.gt(0) && subtotal.gte(freeThreshold)) deliveryFee = round2(money(0));
    const total = round2(subtotal.plus(deliveryFee));

    // ③ find-or-create عميل نقدي بالهاتف (creditLimit "0" = نقدي فقط، لا ائتمان).
    // منع التكرار تحت التزامن (مراجعة عدائية ١٢/٧): GET_LOCK وحده لا يكفي — يُحرَّر في finally قبل
    // COMMIT، وقراءة snapshot تحت REPEATABLE READ لا ترى إدراج المعاملة الأخرى. **القفل الحقيقي هو
    // قفل صفّ الفهرس**: البحث بـ`.for("update")` يقرأ آخر مُلتزَم ويحجز الصفّ/الفجوة، فطلبٌ ثانٍ
    // بنفس الهاتف يتربّص على قفل الإدراج الأول حتى يلتزم ثم يجده فيعيد استعماله (نمط credit.ts).
    // نُبقي GET_LOCK كتسلسُلٍ مبكّر يُجنّب تسابق الفجوة (deadlock) في المسار الشائع.
    const custLock = `online-customer:${phone}`;
    const lockRes = (await tx.execute(sql`SELECT GET_LOCK(${custLock}, 5) AS locked`)) as unknown;
    const lockedRow = Array.isArray(lockRes) ? (lockRes[0] as { locked?: number }[])?.[0] : (lockRes as { rows?: { locked?: number }[] })?.rows?.[0];
    if (!lockedRow || Number(lockedRow.locked) !== 1) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّر تأمين إنشاء العميل — أعد المحاولة" });
    }
    let customerId: number;
    try {
      const existingCust = (
        await tx.select({ id: customers.id, name: customers.name }).from(customers).where(eq(customers.phone, phone)).limit(1).for("update")
      )[0];
      if (existingCust) {
        customerId = Number(existingCust.id);
      } else {
        const insCust = await tx.insert(customers).values({
          name,
          phone,
          customerType: "فرد",
          defaultPriceTier: RETAIL,
          creditLimit: "0",
          currentBalance: "0",
          isActive: true,
        });
        customerId = extractInsertId(insCust);
      }
    } finally {
      await tx.execute(sql`SELECT RELEASE_LOCK(${custLock})`);
    }

    // ④ إنشاء الطلب (PENDING) — رقمٌ مؤقّت فريد ثم ORD-{id} (بلا سباق ترقيم).
    const insOrder = await tx.insert(onlineOrders).values({
      orderNumber: `TMP-${randomUUID()}`,
      customerId,
      branchId,
      subtotal: toDbMoney(subtotal),
      shippingCost: toDbMoney(deliveryFee),
      taxAmount: "0",
      total: toDbMoney(total),
      status: "PENDING",
      shippingAddress: requestedShippingAddress,
      governorate: input.governorate,
      latitude: input.latitude != null ? String(input.latitude) : null,
      longitude: input.longitude != null ? String(input.longitude) : null,
      clientRequestId: input.clientRequestId ?? null,
    });
    const orderId = extractInsertId(insOrder);
    const orderNumber = `ORD-${100000 + orderId}`;
    await tx.update(onlineOrders).set({ orderNumber }).where(eq(onlineOrders.id, orderId));

    // ⑤ بنود الطلب (لقطة السعر الخادمي).
    for (const it of items) {
      await tx.insert(onlineOrderItems).values({
        onlineOrderId: orderId,
        variantId: it.variantId,
        productUnitId: it.productUnitId,
        quantity: toDbQty(it.quantity),
        baseQuantity: it.baseQuantity,
        unitPrice: it.unitPrice,
        total: it.lineTotal,
      });
    }

    return {
      orderId,
      orderNumber,
      branchId,
      subtotal: toDbMoney(subtotal),
      deliveryFee: toDbMoney(deliveryFee),
      total: toDbMoney(total),
      itemCount: items.length,
    };
  });
}

export interface OnlineOrderTracking {
  orderNumber: string;
  status: string;
  subtotal: string;
  deliveryFee: string;
  total: string;
  governorate: string | null;
  createdAt: Date;
  items: { productName: string; unitName: string; quantity: string; unitPrice: string; total: string }[];
}

/**
 * تتبّع الطلب: يتطلّب **رقم الطلب + الهاتف معاً** (خصوصية — لا يكفي تخمين الرقم لرؤية طلب غيرك).
 * null إن لم يُطابِق.
 */
export async function trackOnlineOrder(orderNumber: string, phone: string): Promise<OnlineOrderTracking | null> {
  const db = getDb();
  if (!db) return null;
  const order = (
    await db
      .select({
        id: onlineOrders.id,
        orderNumber: onlineOrders.orderNumber,
        status: onlineOrders.status,
        subtotal: onlineOrders.subtotal,
        shippingCost: onlineOrders.shippingCost,
        total: onlineOrders.total,
        governorate: onlineOrders.governorate,
        createdAt: onlineOrders.createdAt,
        customerPhone: customers.phone,
      })
      .from(onlineOrders)
      .innerJoin(customers, eq(onlineOrders.customerId, customers.id))
      // الهاتف المخزَّن E.164 (normalizeStorePhone عند الإنشاء) ⇒ نُوحِّد المُدخَل قبل المطابقة،
      // وإلا لم يُطابق زبونٌ يُدخِل رقمه بصيغته المحلّية «0770…» رقمَه المخزَّن «+964770…» أبداً.
      .where(and(eq(onlineOrders.orderNumber, orderNumber.trim()), eq(customers.phone, normalizeStorePhone(phone))))
      .limit(1)
  )[0];
  if (!order) return null;

  const rows = await db
    .select({
      productName: products.name,
      unitName: productUnits.unitName,
      quantity: onlineOrderItems.quantity,
      unitPrice: onlineOrderItems.unitPrice,
      total: onlineOrderItems.total,
    })
    .from(onlineOrderItems)
    .innerJoin(productVariants, eq(onlineOrderItems.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(productUnits, eq(onlineOrderItems.productUnitId, productUnits.id))
    .where(eq(onlineOrderItems.onlineOrderId, Number(order.id)));

  return {
    orderNumber: order.orderNumber,
    status: order.status,
    subtotal: String(order.subtotal),
    deliveryFee: String(order.shippingCost),
    total: String(order.total),
    governorate: order.governorate ?? null,
    createdAt: order.createdAt,
    items: rows.map((r) => ({
      productName: r.productName,
      unitName: r.unitName ?? "",
      quantity: String(r.quantity),
      unitPrice: String(r.unitPrice),
      total: String(r.total),
    })),
  };
}
