import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  customers,
  storefrontQuoteRequestItems,
  storefrontQuoteRequests,
} from "../../../drizzle/schema";
import { appErrorMessage } from "@shared/errors";
import { getDb, type Tx } from "../../db";
import { withTx } from "../tx";

export type StorefrontQuoteRequestStatus =
  | "PENDING"
  | "CONTACTED"
  | "QUOTED"
  | "CLOSED"
  | "CANCELLED";

const ALLOWED_TRANSITIONS: Record<
  StorefrontQuoteRequestStatus,
  StorefrontQuoteRequestStatus[]
> = {
  PENDING: ["CONTACTED", "CANCELLED"],
  CONTACTED: ["QUOTED", "CLOSED", "CANCELLED"],
  QUOTED: ["CLOSED", "CANCELLED"],
  CLOSED: [],
  CANCELLED: [],
};

export async function listStorefrontQuoteRequests(input: {
  scopedBranchId: number | null;
  status?: StorefrontQuoteRequestStatus | null;
  limit?: number;
}) {
  const db = getDb();
  if (!db) return [];
  const conditions = [
    input.scopedBranchId != null
      ? eq(storefrontQuoteRequests.branchId, input.scopedBranchId)
      : undefined,
    input.status ? eq(storefrontQuoteRequests.status, input.status) : undefined,
  ].filter(Boolean);
  const rows = await db
    .select({
      id: storefrontQuoteRequests.id,
      requestNumber: storefrontQuoteRequests.requestNumber,
      branchId: storefrontQuoteRequests.branchId,
      status: storefrontQuoteRequests.status,
      requestType: storefrontQuoteRequests.requestType,
      companyName: storefrontQuoteRequests.companyName,
      governorate: storefrontQuoteRequests.governorate,
      contactPreference: storefrontQuoteRequests.contactPreference,
      customerNote: storefrontQuoteRequests.customerNote,
      staffNote: storefrontQuoteRequests.staffNote,
      createdAt: storefrontQuoteRequests.createdAt,
      customerName: customers.name,
      customerPhone: customers.phone,
    })
    .from(storefrontQuoteRequests)
    .leftJoin(customers, eq(customers.id, storefrontQuoteRequests.customerId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(storefrontQuoteRequests.id))
    .limit(Math.min(Math.max(input.limit ?? 100, 1), 300));
  const ids = rows.map((row) => Number(row.id));
  const items = ids.length
    ? await db
        .select({
          quoteRequestId: storefrontQuoteRequestItems.quoteRequestId,
          productName: storefrontQuoteRequestItems.productName,
          variantLabel: storefrontQuoteRequestItems.variantLabel,
          unitName: storefrontQuoteRequestItems.unitName,
          quantity: storefrontQuoteRequestItems.quantity,
        })
        .from(storefrontQuoteRequestItems)
        .where(inArray(storefrontQuoteRequestItems.quoteRequestId, ids))
    : [];
  const itemsByRequest = new Map<number, typeof items>();
  for (const item of items) {
    const requestId = Number(item.quoteRequestId);
    itemsByRequest.set(requestId, [...(itemsByRequest.get(requestId) ?? []), item]);
  }
  return rows.map((row) => ({
    id: Number(row.id),
    requestNumber: row.requestNumber,
    branchId: Number(row.branchId),
    status: row.status as StorefrontQuoteRequestStatus,
    requestType: row.requestType,
    companyName: row.companyName ?? null,
    governorate: row.governorate ?? null,
    contactPreference: row.contactPreference,
    customerNote: row.customerNote,
    staffNote: row.staffNote ?? null,
    customerName: row.customerName ?? null,
    customerPhone: row.customerPhone ?? null,
    createdAt: row.createdAt,
    items: (itemsByRequest.get(Number(row.id)) ?? []).map((item) => ({
      productName: item.productName,
      variantLabel: item.variantLabel ?? null,
      unitName: item.unitName,
      quantity: Number(item.quantity),
    })),
  }));
}

export async function updateStorefrontQuoteRequestStatus(
  input: {
    requestId: number;
    status: StorefrontQuoteRequestStatus;
    staffNote?: string | null;
    scopedBranchId: number | null;
  },
): Promise<{ requestId: number; from: StorefrontQuoteRequestStatus; to: StorefrontQuoteRequestStatus }> {
  return withTx(async (tx: Tx) => {
    const request = (
      await tx
        .select({
          id: storefrontQuoteRequests.id,
          branchId: storefrontQuoteRequests.branchId,
          status: storefrontQuoteRequests.status,
        })
        .from(storefrontQuoteRequests)
        .where(eq(storefrontQuoteRequests.id, input.requestId))
        .for("update")
        .limit(1)
    )[0];
    if (!request) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر تحديث طلب عرض السعر",
          why: "رقم طلب العرض غير موجود أو لم يعد متاحاً",
          doThis: "حدّث قائمة طلبات عروض الأسعار ثم اختر الطلب الموجود",
        }),
      });
    }
    if (input.scopedBranchId != null && Number(request.branchId) !== input.scopedBranchId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "تعذّر تحديث طلب عرض السعر",
          why: "الطلب يتبع فرعاً آخر خارج نطاق صلاحيتك",
          doThis: "افتح الطلب من الفرع المكلّف به أو اطلب من مدير الفرع المتابعة",
        }),
      });
    }
    const from = request.status as StorefrontQuoteRequestStatus;
    if (from === input.status) return { requestId: input.requestId, from, to: input.status };
    if (!ALLOWED_TRANSITIONS[from].includes(input.status)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر تحديث حالة طلب عرض السعر",
          why: `الحالة الحالية «${from}» لا تسمح بالانتقال إلى «${input.status}»`,
          doThis: "حدّث الطلب ثم اختر الإجراء التالي المتاح في مسار المتابعة",
        }),
      });
    }
    await tx
      .update(storefrontQuoteRequests)
      .set({
        status: input.status,
        staffNote: input.staffNote?.trim() || null,
      })
      .where(eq(storefrontQuoteRequests.id, input.requestId));
    return { requestId: input.requestId, from, to: input.status };
  });
}
