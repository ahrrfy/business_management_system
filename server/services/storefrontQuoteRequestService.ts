/**
 * استفسارات عروض سعر المتجر. هذا المسار متعمّد أن يكون بلا تسعير أو حجز مخزون أو سند مالي:
 * يلتقط حاجة الشركات/الكميات/الطباعة، ثم ينشئ الموظف العرض الرسمي بعد مراجعة التوفر والتخصيص.
 */
import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray } from "drizzle-orm";
import {
  productUnits,
  productVariants,
  products,
  storefrontQuoteRequestItems,
  storefrontQuoteRequests,
} from "../../drizzle/schema";
import { appErrorMessage } from "@shared/errors";
import type { Tx } from "../db";
import { extractInsertId } from "../lib/insertId";
import { retryOnDup } from "../lib/retryDup";
import { money } from "./money";
import {
  lockOrCreateOnlineCustomer,
  normalizeStorePhone,
} from "./onlineOrderService";
import { requireStorefrontContext } from "./storefrontContextService";
import { withTx } from "./tx";

export type StorefrontQuoteRequestType =
  | "BULK"
  | "CUSTOM_PRINT"
  | "BUSINESS"
  | "GENERAL";
export type StorefrontQuoteContactPreference = "PHONE" | "WHATSAPP";

export interface CreateStorefrontQuoteRequestInput {
  customerName: string;
  customerPhone: string;
  companyName?: string | null;
  governorate?: string | null;
  contactPreference: StorefrontQuoteContactPreference;
  requestType: StorefrontQuoteRequestType;
  note: string;
  clientRequestId: string;
  lines: Array<{ productUnitId: number; quantity: number }>;
  authenticatedCustomer?: { customerId: number; phone: string } | null;
}

function normalizeLines(
  lines: CreateStorefrontQuoteRequestInput["lines"],
): Array<{ productUnitId: number; quantity: number }> {
  const byUnit = new Map<number, number>();
  for (const line of lines) {
    const unitId = Number(line.productUnitId);
    const quantity = Math.floor(Number(line.quantity));
    if (
      !Number.isSafeInteger(unitId) ||
      unitId <= 0 ||
      !Number.isSafeInteger(quantity) ||
      quantity <= 0 ||
      quantity > 10_000
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر إرسال طلب عرض السعر",
          why: "توجد كمية أو وحدة منتج غير صالحة في الطلب",
          doThis: "حدّث السلّة وتأكد من الكميات ثم أرسل الطلب من جديد",
        }),
      });
    }
    byUnit.set(unitId, (byUnit.get(unitId) ?? 0) + quantity);
  }
  const normalized = Array.from(byUnit, ([productUnitId, quantity]) => ({
    productUnitId,
    quantity,
  })).sort((a, b) => a.productUnitId - b.productUnitId);
  if (!normalized.length || normalized.length > 30) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر إرسال طلب عرض السعر",
        why: "يجب أن يحتوي الطلب على منتج واحد إلى 30 منتجاً مختلفاً",
        doThis: "قسّم الطلب الكبير إلى أكثر من طلب عرض سعر ثم أرسله",
      }),
    });
  }
  return normalized;
}

function variantLabel(row: {
  variantName: string | null;
  color: string | null;
  size: string | null;
}): string | null {
  const label = Array.from(
    new Set(
      [row.variantName, row.color, row.size]
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  ).join(" — ");
  return label || null;
}

async function loadRequestItems(
  tx: Tx,
  lines: Array<{ productUnitId: number; quantity: number }>,
) {
  const rows = await tx
    .select({
      productUnitId: productUnits.id,
      unitName: productUnits.unitName,
      conversionFactor: productUnits.conversionFactor,
      unitActive: productUnits.isActive,
      variantName: productVariants.variantName,
      color: productVariants.color,
      size: productVariants.size,
      variantActive: productVariants.isActive,
      productName: products.name,
      productActive: products.isActive,
    })
    .from(productUnits)
    .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(inArray(productUnits.id, lines.map((line) => line.productUnitId)));
  const byUnit = new Map(rows.map((row) => [Number(row.productUnitId), row]));
  return lines.map((line) => {
    const row = byUnit.get(line.productUnitId);
    if (!row || !row.productActive || !row.variantActive || !row.unitActive) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر إرسال طلب عرض السعر",
          why: "أحد المنتجات التي اخترتها لم يعد متاحاً في الكتالوج",
          doThis: "حدّث السلّة واحذف الصنف غير المتاح، أو اكتب احتياجك في ملاحظات الطلب",
        }),
      });
    }
    const baseQuantity = money(line.quantity).times(row.conversionFactor ?? 1);
    if (!baseQuantity.isInteger() || !baseQuantity.gt(0)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر إرسال طلب عرض السعر",
          why: "وحدة أحد المنتجات غير مضبوطة لحساب الكمية",
          doThis: "اكتب احتياجك في ملاحظات الطلب وسيراجعه فريق المكتبة معك",
        }),
      });
    }
    return {
      productUnitId: line.productUnitId,
      productName: row.productName,
      variantLabel: variantLabel(row),
      unitName: row.unitName,
      quantity: line.quantity,
      baseQuantity: baseQuantity.toNumber(),
    };
  });
}

export async function createStorefrontQuoteRequest(
  input: CreateStorefrontQuoteRequestInput,
): Promise<{
  requestId: number;
  requestNumber: string;
  idempotentReplay: boolean;
}> {
  // قد تصل نقرتان بالمعرّف نفسه قبل التزام الأولى؛ القيد الفريد هو الحكم، وإعادة المحاولة
  // تجعل الثانية تقرأ الطلب الفائز بدلاً من تحويل إعادة الإرسال الطبيعية إلى خطأ للمستخدم.
  return retryOnDup(() => createStorefrontQuoteRequestAttempt(input));
}

async function createStorefrontQuoteRequestAttempt(
  input: CreateStorefrontQuoteRequestInput,
): Promise<{
  requestId: number;
  requestNumber: string;
  idempotentReplay: boolean;
}> {
  const name = input.customerName.trim();
  const phone = normalizeStorePhone(input.customerPhone);
  const note = input.note.trim();
  const clientRequestId = input.clientRequestId.trim();
  if (!name || !note || !clientRequestId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر إرسال طلب عرض السعر",
        why: "بيانات التواصل أو وصف الاحتياج غير مكتملة",
        doThis: "أدخل الاسم ورقم الهاتف ووصفاً مختصراً لما تحتاجه ثم أعد الإرسال",
      }),
    });
  }
  const lines = normalizeLines(input.lines);
  return withTx(async (tx) => {
    // الطلب التجاري يبقى متاحاً حتى عند إغلاق البيع المباشر، لكن لا يقبل فرعاً غائباً أو معطلاً.
    const storefront = await requireStorefrontContext(tx, {
      requireOpen: false,
      lock: true,
      branchLock: "share",
    });
    const customerId = await lockOrCreateOnlineCustomer(
      tx,
      phone,
      name,
      input.authenticatedCustomer,
    );
    const replay = (
      await tx
        .select({
          id: storefrontQuoteRequests.id,
          requestNumber: storefrontQuoteRequests.requestNumber,
          customerId: storefrontQuoteRequests.customerId,
        })
        .from(storefrontQuoteRequests)
        .where(eq(storefrontQuoteRequests.clientRequestId, clientRequestId))
        .for("update")
        .limit(1)
    )[0];
    if (replay) {
      if (Number(replay.customerId) !== customerId) {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر إرسال طلب عرض السعر",
            why: "رمز الإرسال هذا مستعمل لطلب عميل آخر",
            doThis: "حدّث الصفحة ثم أعد الإرسال، وسيُنشأ رمز جديد تلقائياً",
          }),
        });
      }
      return {
        requestId: Number(replay.id),
        requestNumber: replay.requestNumber,
        idempotentReplay: true,
      };
    }
    const items = await loadRequestItems(tx, lines);
    const inserted = await tx.insert(storefrontQuoteRequests).values({
      // clientRequestId يصل إلى 80 حرفاً، بينما requestNumber لا يتجاوز 50. لا نضعه هنا
      // كي لا يفشل الطلب الصحيح؛ الاسم المؤقت لا يظهر للعميل ويُستبدل برقم SRQ داخل المعاملة.
      requestNumber: `TMP-${randomUUID()}`,
      branchId: storefront.branchId,
      customerId,
      requestType: input.requestType,
      companyName: input.companyName?.trim() || null,
      governorate: input.governorate?.trim() || null,
      contactPreference: input.contactPreference,
      customerNote: note,
      clientRequestId,
    });
    const requestId = extractInsertId(inserted);
    const requestNumber = `SRQ-${100000 + requestId}`;
    await tx
      .update(storefrontQuoteRequests)
      .set({ requestNumber })
      .where(eq(storefrontQuoteRequests.id, requestId));
    await tx.insert(storefrontQuoteRequestItems).values(
      items.map((item) => ({ quoteRequestId: requestId, ...item })),
    );
    return { requestId, requestNumber, idempotentReplay: false };
  });
}
