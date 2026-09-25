import { TRPCError } from "@trpc/server";
import { normalizeBarcodeScannerInput, stripTrackingLeadingZeros } from "@shared/barcodeScanner";
import { isDupEntry } from "@shared/errorMap.ar";
import { appErrorMessage } from "@shared/errors";
import { and, eq, ne, or, sql } from "drizzle-orm";
import { deliveryConsignments } from "../../../drizzle/schema";
import type { Tx } from "../../db";


export type DeliveryPartyType = "INDIVIDUAL" | "COMPANY";

export const DELIVERY_TRACKING_REF_UNIQUE_KEY = "uq_consignment_party_tracking_ref";

/**
 * رقم بوليصة شركة التوصيل هو مفتاح المطابقة مع كشفها الورقي. نستعمل مطبّع الماسح
 * المشترك نفسه كي تكون قيمة البحث والقيمة المخزّنة متطابقتين دائماً.
 */
export function normalizeExternalTrackingRef(value?: string | null): string | null {
  const normalized = normalizeBarcodeScannerInput(value ?? "");
  return normalized.length > 0 ? normalized : null;
}

function externalTrackingRefConflict(
  externalTrackingRef: string,
  duplicateConsignmentNumber?: string | null,
  cause?: unknown,
): TRPCError {
  return new TRPCError({
    code: "CONFLICT",
    message: appErrorMessage({
      what: "تعذّر حفظ بوليصة شركة التوصيل",
      why: duplicateConsignmentNumber
        ? `رقم البوليصة ${externalTrackingRef} مرتبط مسبقاً بالإرسالية ${duplicateConsignmentNumber}`
        : `رقم البوليصة ${externalTrackingRef} مستخدم مسبقاً لدى جهة التوصيل نفسها`,
      doThis: "امسح الباركود الصحيح لهذه الشحنة، أو افتح الإرسالية السابقة وصحّح رقم بوليصتها أولاً",
    }),
    cause,
  });
}

function errorChainMentionsTrackingRefUniqueKey(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current !== "object") return false;
    const record = current as Record<string, unknown>;
    if ([record.message, record.sqlMessage, record.constraint, record.index]
      .some((value) => typeof value === "string" && value.includes(DELIVERY_TRACKING_REF_UNIQUE_KEY))) {
      return true;
    }
    current = record.cause;
  }
  return false;
}

/** يحوّل تصادم قيد بوليصة الشركة وحده إلى تعارض أعمال، ويُبقي أيّ تكرار آخر كما هو. */
export function rethrowExternalTrackingRefDuplicate(
  error: unknown,
  externalTrackingRef: string,
): never {
  if (!isDupEntry(error) || !errorChainMentionsTrackingRefUniqueKey(error)) throw error;
  throw externalTrackingRefConflict(externalTrackingRef, null, error);
}

/** شركات التوصيل تحتاج رقم البوليصة كي يمكن مطابقة الفاتورة لاحقاً بالماسح. */
export function requireExternalTrackingRef(
  partyType: DeliveryPartyType,
  value?: string | null,
): string | null {
  const normalized = normalizeExternalTrackingRef(value);
  if (partyType === "COMPANY" && normalized == null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر إسناد الشحنة إلى شركة التوصيل",
        why: "رقم تتبّع/بوليصة الشركة مطلوب لربط الفاتورة بكشف التحصيل لاحقاً",
        doThis: "امسح باركود بوليصة الشركة أو أدخل رقمها ثم أعد الإسناد",
      }),
    });
  }
  if (normalized != null && normalized.length > 100) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر حفظ رقم بوليصة شركة التوصيل",
        why: "رقم التتبّع أطول من الحد المسموح (100 محرف)",
        doThis: "أدخل الرقم المطبوع أسفل باركود البوليصة فقط، من دون وصفٍ إضافي",
      }),
    });
  }
  return normalized;
}

/**
 * رقم البوليصة فريد داخل الشركة الواحدة. يستدعيه الكاتب بعد قفل صف الجهة؛ بذلك تتسلسل
 * محاولات الشركة نفسها ولا يستطيع طلبان متزامنان تجاوز الفحص قبل الإدراج.
 */
export async function assertExternalTrackingRefAvailable(
  tx: Tx,
  partyId: number,
  externalTrackingRef: string | null,
  ignoreConsignmentId?: number | null,
): Promise<void> {
  if (externalTrackingRef == null) return;
  const stripped = stripTrackingLeadingZeros(externalTrackingRef);
  const duplicate = (
    await tx
      .select({ id: deliveryConsignments.id, consignmentNumber: deliveryConsignments.consignmentNumber })
      .from(deliveryConsignments)
      .where(and(
        eq(deliveryConsignments.partyId, partyId),
        or(
          eq(deliveryConsignments.externalTrackingRef, externalTrackingRef),
          eq(sql`TRIM(LEADING '0' FROM ${deliveryConsignments.externalTrackingRef})`, stripped),
        ),
        ignoreConsignmentId != null
          ? ne(deliveryConsignments.id, Number(ignoreConsignmentId))
          : undefined,
      ))
      .for("update")
      .limit(1)
  )[0];
  if (!duplicate) return;
  throw externalTrackingRefConflict(externalTrackingRef, duplicate.consignmentNumber);
}

