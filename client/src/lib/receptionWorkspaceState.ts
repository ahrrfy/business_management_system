import type {
  CartLine,
  PayMethod,
  PosRow,
  Tier,
} from "@/components/reception/cartMath";
import type { CustomizationData } from "@/components/CustomizationDialog";
import { isValidIqMobile, toLocalIqMobileDigits } from "@/components/form/PhoneDigitsInput";
import { useUnsavedGuard } from "@/hooks/useUnsavedGuard";
import { toWorkOrderChannel, type WorkOrderChannel } from "@shared/receptionChannel";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export const RECEPTION_WORKSPACE_SCHEMA_VERSION = 3 as const;
export const RECEPTION_WORKSPACE_TTL_MS = 24 * 60 * 60 * 1_000;
export const RECEPTION_WORKSPACE_STORAGE_PREFIX = "erp:reception-workspace:";
const RECEPTION_WORKSPACE_BOUNDARY_BLOCK_KEY = "erp:reception-workspace-boundary-blocked";

const FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const MAX_SERIALIZED_CHARS = 4_000_000;
const MAX_MONEY = 1_000_000_000_000;
const MAX_LINE_QUANTITY = 1_000_000;
const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TIERS = new Set<Tier>(["RETAIL", "WHOLESALE", "GOVERNMENT"]);
const PAY_METHODS = new Set<PayMethod>(["CASH", "CARD", "TRANSFER", "WALLET", "TELECOM"]);
const CHANNELS = new Set<WorkOrderChannel>([
  "OTHER",
  "WALK_IN",
  "WHATSAPP",
  "INSTAGRAM",
  "TIKTOK",
  "PHONE",
]);
const DEFINITIVE_PROMOTION_REJECTION_CODES = new Set(["BAD_REQUEST", "FORBIDDEN", "UNAUTHORIZED", "NOT_FOUND", "PRECONDITION_FAILED"]);

export function isDefinitiveReceptionPromotionRejection(error: unknown): boolean {
  const code = (error as { data?: { code?: string } } | null)?.data?.code;
  return typeof code === "string" && DEFINITIVE_PROMOTION_REJECTION_CODES.has(code);
}

/**
 * لا تدخل هذه الحقول إلى sessionStorage حتى لو أضيفت لاحقاً إلى كائن السلة. صور التصميم
 * جزء من الطلب وتبقى، أمّا صور إثبات الدفع وبيانات الاعتماد/البطاقة فليست حالة واجهة قابلة
 * للتخزين في المتصفح.
 */
const SENSITIVE_KEYS = new Set([
  "password",
  "managerapproval",
  "paymentreceiptimages",
  "paymentreference",
  "cardnumber",
  "cvv",
  "pin",
  "credentials",
  "costpricebase",
]);

/** حقول تشغيل السلة فقط؛ تكلفة الصنف وسائر إضافات API المستقبلية لا تُنسخ إلى المتصفح. */
const RECEPTION_PERSISTED_POS_ROW_KEYS = [
  "branchId", "productId", "productName", "variantId", "variantName", "color", "colorHex", "size", "sku",
  "productUnitId", "unitName", "conversionFactor", "barcode", "isBaseUnit", "price", "stockBase", "reservedBase",
  "availableBase", "openedAt", "isService", "allowBackorder", "isCustomizable", "isPrintService", "isContractPrice",
  "isBundle", "isConsignment", "promotionId", "promotionName", "promotionDiscountForUnit", "promotionEffectivePrice",
] as const;

function projectReceptionPersistedRow(row: PosRow): PosRow {
  const source = row as unknown as Record<string, unknown>;
  return Object.fromEntries(RECEPTION_PERSISTED_POS_ROW_KEYS.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]])) as unknown as PosRow;
}

export type ReceptionWorkspaceCustomer = {
  customerId: number | null;
  name: string;
  phone: string | null;
  isNew: boolean;
};

export type ReceptionConversationSeed = {
  conversationId: number;
  customerId: number | null;
  channel: string;
  channelHandle: string;
  displayName: string | null;
};

/** يحوّل خيط الرسائل إلى رأس طلب فقط؛ لا ينشئ عميلاً صامتاً. */
export function prepareReceptionConversationStart(input: ReceptionConversationSeed) {
  const localPhone = toLocalIqMobileDigits(input.channelHandle);
  const validPhone = isValidIqMobile(localPhone);
  return {
    linkedConversationId: input.conversationId,
    channel: toWorkOrderChannel(input.channel),
    channelHandle: input.channelHandle,
    localPhone: validPhone ? localPhone : null,
    customer: {
      customerId: input.customerId,
      name: input.displayName ?? "",
      phone: validPhone ? localPhone : null,
      isNew: false,
    } satisfies ReceptionWorkspaceCustomer,
  };
}

type ReceptionPhoneResolution = {
  status: string;
  customerId?: unknown;
  defaultPriceTier?: unknown;
  name?: string | null;
  phone?: string | null;
};

/** يعيد حسم هوية العميل وفئته من الهاتف قبل استعمال أي أسعار محفوظة. */
export async function resolveReceptionRestoredPricingContext(
  input: { customer: ReceptionWorkspaceCustomer; phoneInput: string },
  resolveByPhone: (phone: string) => Promise<ReceptionPhoneResolution>,
  resolveById?: (customerId: number) => Promise<ReceptionPhoneResolution>,
): Promise<{ customer: ReceptionWorkspaceCustomer; tier: Tier }> {
  const { customer: savedCustomer, phoneInput } = input;
  const validPhone = isValidIqMobile(phoneInput);
  if (!validPhone && savedCustomer.customerId == null) return { customer: savedCustomer, tier: "RETAIL" };
  if (!validPhone && !resolveById) throw new Error("تعذّر التحقق من فئة العميل المحفوظ");
  const result = validPhone ? await resolveByPhone(phoneInput) : await resolveById!(savedCustomer.customerId!);
  if (result.status !== "RESOLVED") {
    if (savedCustomer.customerId != null) throw new Error("لم تعد هوية العميل المحفوظة متاحة");
    return { customer: { ...savedCustomer, customerId: null, phone: phoneInput, isNew: true }, tier: "RETAIL" };
  }
  const customerId = Number(result.customerId);
  const tier = result.defaultPriceTier as Tier;
  if (!Number.isSafeInteger(customerId) || customerId <= 0 || (savedCustomer.customerId != null && savedCustomer.customerId !== customerId) || !TIERS.has(tier)) {
    throw new Error("تغيّرت هوية العميل أو فئته؛ لم نستعد أسعاراً قديمة");
  }
  return { customer: { customerId, name: result.name ?? savedCustomer.name, phone: validPhone ? phoneInput : (result.phone ?? savedCustomer.phone), isNew: false }, tier };
}

export type ReceptionLocalWorkspaceSnapshot = {
  version: typeof RECEPTION_WORKSPACE_SCHEMA_VERSION;
  kind: "LOCAL";
  savedAt: number;
  expiresAt: number;
  clientRequestId: string;
  cart: CartLine[];
  customer: ReceptionWorkspaceCustomer;
  phoneInput: string;
  customerCreditLimit: string;
  tierOverride: Tier | null;
  /** الفئة التي سُعّرت بها السلة فعلياً؛ لا نسقط إلى RETAIL أثناء حسم الهاتف بعد الاستعادة. */
  effectiveTier: Tier;
  /** محاولة ترقية قد تكون وصلت للخادم ولم يُحسم ردّها؛ تمنع التثبيت المباشر حتى replay آمن. */
  draftPromotionPending: boolean;
  draftPromotionShiftId: number | null;
  /** نسخة استرداد مفصولة عن مسودة خادمية؛ يجب حفظها كمسودة جديدة قبل القبض أو التثبيت. */
  detachedRecoveryPending: boolean;
  payment: {
    amount: string;
    method: PayMethod;
    deferred: boolean;
  };
  invoiceDiscountPct: string;
  coupon: {
    input: string;
    code: string | null;
    label: string | null;
  };
  channel: {
    kind: WorkOrderChannel;
    handle: string;
    linkedConversationId: number | null;
  };
};

/**
 * المسوّدة الخادمية لا تُستعاد من نسخة سلة محلية: قد يكون زميل قد عدّلها أو ثبّتها. نخزّن
 * هويتها فقط، ثم تجلب Reception الحقيقة الحالية من draftGet قبل إتاحة أي تعديل.
 */
export type ReceptionServerDraftPointer = {
  version: typeof RECEPTION_WORKSPACE_SCHEMA_VERSION;
  kind: "SERVER_DRAFT";
  savedAt: number;
  expiresAt: number;
  clientRequestId: string;
  activeDraftId: number;
  draftVersion: number;
  /** ظلّ محليّ لآخر حالة مرئية؛ يمنع فقد تعديلات debounce/انقطاع الشبكة. */
  pendingLocal: ReceptionLocalWorkspaceSnapshot;
  /** مؤشر v1 داخل الذاكرة فقط؛ لا يُكتب بصيغته القديمة ويُجلب من الخادم بلا shadow. */
  legacyIdentityOnly?: true;
};

export type ReceptionWorkspaceSnapshot =
  | ReceptionLocalWorkspaceSnapshot
  | ReceptionServerDraftPointer;

export type ReceptionLocalWorkspaceInput = {
  clientRequestId: string;
  cart: CartLine[];
  customer: ReceptionWorkspaceCustomer;
  phoneInput: string;
  customerCreditLimit: string;
  tierOverride: Tier | null;
  effectiveTier: Tier;
  draftPromotionPending: boolean;
  draftPromotionShiftId: number | null;
  detachedRecoveryPending: boolean;
  payInput: string;
  method: PayMethod;
  deferred: boolean;
  invoiceDiscountPct: string;
  couponInput: string;
  couponCode: string | null;
  couponLabel: string | null;
  channel: WorkOrderChannel;
  channelHandle: string;
  linkedConversationId: number | null;
};

export type ReceptionWorkspaceDirtyInput = {
  cartLength: number;
  customerId: number | null;
  customerName: string;
  customerPhone: string | null;
  customerIsNew: boolean;
  phoneInput: string;
  customerCreditLimit: string;
  tierOverride: Tier | null;
  payInput: string;
  method: PayMethod;
  paymentReference: string;
  deferred: boolean;
  invoiceDiscountPct: string;
  couponInput: string;
  couponCode: string | null;
  couponLabel: string | null;
  channel: WorkOrderChannel;
  channelHandle: string;
  linkedConversationId: number | null;
  activeDraftId: number | null;
  draftHeld: string;
};

export type ReceptionDraftHandle = { id: number; version: number };
export type ReceptionDraftSyncOutcome =
  | { ok: true; draftId: number; version: number }
  | { ok: false; draftId: number | null; reason: "NO_ACTIVE" | "SUPERSEDED" | "FAILED"; error: unknown };

export type ReceptionDraftSyncQueue<TPayload> = {
  enqueue: (draftId: number | null, payload: TPayload) => Promise<ReceptionDraftSyncOutcome>;
  reset: () => void;
  supersedeAndDrain: () => Promise<void>;
};

/**
 * طابور مزامنة مستقلّ وقابل للاختبار: يثبّت هوية الطلب مع الحمولة، لكنه يقرأ نسخته بعد
 * اكتمال الطلب السابق. reset يفصل الجيل؛ لذلك لا يستطيع رد قديم لمسّ دورة شاشة جديدة.
 */
export function createReceptionDraftSyncQueue<TPayload>(deps: {
  getActive: () => ReceptionDraftHandle | null;
  sync: (input: { draftId: number; version: number; payload: TPayload }) => Promise<{ version: number }>;
  applyVersion: (draftId: number, version: number) => void;
}): ReceptionDraftSyncQueue<TPayload> {
  let flight: Promise<ReceptionDraftSyncOutcome> | null = null;
  let generation = 0;
  return {
    enqueue(draftId, payload) {
      if (draftId == null) return Promise.resolve({ ok: false, draftId: null, reason: "NO_ACTIVE", error: new Error("لا طلب محفوظ نشط") });
      const previous = flight;
      const requestGeneration = generation;
      let request!: Promise<ReceptionDraftSyncOutcome>;
      request = (async () => {
        if (previous) await previous;
        const active = deps.getActive();
        if (requestGeneration !== generation || active?.id !== draftId) {
          return { ok: false, draftId, reason: "SUPERSEDED", error: new Error("تغيّر الطلب النشط") };
        }
        try {
          const result = await deps.sync({ draftId, version: active.version, payload });
          if (requestGeneration !== generation || deps.getActive()?.id !== draftId) {
            return { ok: false, draftId, reason: "SUPERSEDED", error: new Error("انتهت دورة الطلب قبل اكتمال المزامنة") };
          }
          deps.applyVersion(draftId, result.version);
          return { ok: true, draftId, version: result.version };
        } catch (error) {
          return requestGeneration !== generation || deps.getActive()?.id !== draftId
            ? { ok: false, draftId, reason: "SUPERSEDED", error: new Error("انتهت دورة الطلب قبل اكتمال المزامنة") }
            : { ok: false, draftId, reason: "FAILED", error };
        }
      })();
      flight = request;
      void request.finally(() => { if (flight === request) flight = null; });
      return request;
    },
    reset() { generation += 1; flight = null; },
    async supersedeAndDrain() {
      generation += 1;
      const pending = flight;
      if (pending) await pending;
      if (flight === pending) flight = null;
    },
  };
}

export type ReceptionDepositDraftResult =
  | { ok: true; draft: ReceptionDraftHandle; promoted: boolean; draftNumber: string | null; idempotentReplay: boolean }
  | { ok: false; reason: "STALE" | "SYNC" | "PROMOTE"; error?: unknown };

/** يضمن وجود مسوّدة متزامنة قبل إتاحة قبض العربون، بلا أي تعديل UI جزئي. */
export async function prepareReceptionDepositDraft(deps: {
  active: ReceptionDraftHandle | null;
  isCurrent: () => boolean;
  flush: () => Promise<ReceptionDraftSyncOutcome>;
  promote: () => Promise<{ draftId: number; version: number; draftNumber: string; idempotentReplay?: boolean }>;
}): Promise<ReceptionDepositDraftResult> {
  if (deps.active) {
    const synced = await deps.flush();
    if (!deps.isCurrent()) return { ok: false, reason: "STALE" };
    return synced.ok
      ? { ok: true, draft: { id: synced.draftId, version: synced.version }, promoted: false, draftNumber: null, idempotentReplay: false }
      : { ok: false, reason: "SYNC", error: synced.error };
  }
  try {
    const promoted = await deps.promote();
    if (!deps.isCurrent()) return { ok: false, reason: "STALE" };
    return { ok: true, draft: { id: promoted.draftId, version: promoted.version }, promoted: true, draftNumber: promoted.draftNumber, idempotentReplay: promoted.idempotentReplay === true };
  } catch (error) {
    return { ok: false, reason: "PROMOTE", error };
  }
}

export type ReceptionDraftSwitchResult<TDraft> =
  | { ok: true; kind: "NOOP" }
  | { ok: true; kind: "READY"; draft: TDraft }
  | { ok: false; reason: "OFFLINE" | "STALE" | "SYNC" | "LOCAL_DIRTY"; syncOutcome?: Extract<ReceptionDraftSyncOutcome, { ok: false }> };

/** حاجز انتقال A→B: لا يبدأ GET لـB حتى تنتهي آخر مزامنة لـA بنجاح. */
export async function prepareReceptionDraftSwitch<TDraft>(deps: {
  active: ReceptionDraftHandle | null;
  targetDraftId: number;
  forceReload: boolean;
  localDirty?: boolean;
  offline: boolean;
  isCurrent: () => boolean;
  flush: () => Promise<ReceptionDraftSyncOutcome>;
  load: () => Promise<TDraft>;
}): Promise<ReceptionDraftSwitchResult<TDraft>> {
  if (!deps.forceReload && deps.active?.id === deps.targetDraftId) return { ok: true, kind: "NOOP" };
  if (!deps.forceReload && !deps.active && deps.localDirty) return { ok: false, reason: "LOCAL_DIRTY" };
  if (deps.active && deps.active.id !== deps.targetDraftId) {
    if (deps.offline) return { ok: false, reason: "OFFLINE" };
    const flushed = await deps.flush();
    if (!deps.isCurrent()) return { ok: false, reason: "STALE" };
    if (!flushed.ok) return { ok: false, reason: "SYNC", syncOutcome: flushed };
  }
  const draft = await deps.load();
  return deps.isCurrent() ? { ok: true, kind: "READY", draft } : { ok: false, reason: "STALE" };
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function normalizedSensitiveKey(key: string): string {
  return key.replace(/[_-]/g, "").toLowerCase();
}

function safePlainJson(value: unknown, seen = new WeakSet<object>()): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "object") return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);

  if (Array.isArray(value)) {
    const result = value.map((entry) => safePlainJson(entry, seen) ?? null);
    seen.delete(value);
    return result;
  }

  const result: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = normalizedSensitiveKey(key);
    // يبقى عقد CustomizationData سليماً بعد الاستعادة، لكن بلا صورة إثبات الدفع نفسها.
    if (normalizedKey === "paymentreceiptimages") {
      result[key] = [];
      continue;
    }
    if (SENSITIVE_KEYS.has(normalizedKey)) continue;
    const safe = safePlainJson(entry, seen);
    if (safe !== undefined) result[key] = safe;
  }
  seen.delete(value);
  return result;
}

function containsSensitiveKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSensitiveKey);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, entry]) => {
    const normalizedKey = normalizedSensitiveKey(key);
    if (normalizedKey === "paymentreceiptimages") return !Array.isArray(entry) || entry.length > 0;
    return SENSITIVE_KEYS.has(normalizedKey) || containsSensitiveKey(entry);
  });
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

function nullableBoundedString(value: unknown, max: number): value is string | null {
  return value === null || boundedString(value, max);
}

function positiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nullablePositiveInt(value: unknown): value is number | null {
  return value === null || positiveInt(value);
}

function finiteNumberInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function decimalText(value: unknown, opts: { positive?: boolean; max?: number } = {}): value is string {
  if (!boundedString(value, 64) || !/^\d+(?:\.\d+)?$/.test(value)) return false;
  const parsed = Number(value);
  return Number.isFinite(parsed)
    && parsed <= (opts.max ?? MAX_MONEY)
    && (opts.positive ? parsed > 0 : parsed >= 0);
}

function optionalDecimalText(value: unknown, opts: { max?: number } = {}): value is string {
  return value === "" || decimalText(value, opts);
}

function dateInputText(value: unknown): value is string {
  if (value === "") return true;
  if (!boundedString(value, 10) || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function phoneInputText(value: unknown): value is string {
  return value === "" || (boundedString(value, 16) && /^\+?\d{7,15}$/.test(value));
}

function isDesignImage(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ["id", "dataUrl", "url", "isPrimary", "name", "sizeKB"])) return false;
  return boundedString(value.id, 200)
    && boundedString(value.dataUrl, MAX_SERIALIZED_CHARS)
    && (value.url === undefined || boundedString(value.url, 2_000))
    && typeof value.isPrimary === "boolean"
    && (value.name === undefined || boundedString(value.name, 500))
    && (value.sizeKB === undefined || (typeof value.sizeKB === "number" && Number.isFinite(value.sizeKB) && value.sizeKB >= 0));
}

function isCustomization(value: Record<string, unknown>): boolean {
  if (!hasOnlyKeys(value, [
    "title", "unitPrice", "laborCost", "assignedTo", "size", "material", "customizationText",
    "priority", "dueDate", "hasDelivery", "deliveryAddress", "deliveryPhone", "deliveryCost",
    "deliveryFeeCollection", "designImages", "paymentReceiptImages", "deposit",
  ])) return false;
  return boundedString(value.title, 500)
    && optionalDecimalText(value.unitPrice)
    && optionalDecimalText(value.laborCost)
    && nullablePositiveInt(value.assignedTo)
    && boundedString(value.size, 500)
    && boundedString(value.material, 500)
    && boundedString(value.customizationText, 50_000)
    && (value.priority === "LOW" || value.priority === "NORMAL" || value.priority === "URGENT")
    && dateInputText(value.dueDate)
    && typeof value.hasDelivery === "boolean"
    && boundedString(value.deliveryAddress, 2_000)
    && phoneInputText(value.deliveryPhone)
    && optionalDecimalText(value.deliveryCost)
    && (value.deliveryFeeCollection === "COURIER" || value.deliveryFeeCollection === "COUNTER" || value.deliveryFeeCollection === "SHOP")
    && Array.isArray(value.designImages)
    && value.designImages.length <= 20
    && value.designImages.every(isDesignImage)
    && Array.isArray(value.paymentReceiptImages)
    && value.paymentReceiptImages.length === 0
    && optionalDecimalText(value.deposit);
}

function isDigitalStudent(value: unknown): boolean {
  return isRecord(value)
    && hasOnlyKeys(value, ["studentName", "studentPhone"])
    && boundedString(value.studentName, 300)
    && phoneInputText(value.studentPhone);
}

function isDigitalMeta(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "offeringId", "providerId", "priceVersionId", "sellPriceSnapshot", "lineKey",
    "providerName", "offeringType", "providerReference", "providerBasketKey", "faceValue",
    "subscriptionDurationDays", "requiresStudentData", "student",
  ])) return false;
  return positiveInt(value.offeringId)
    && positiveInt(value.providerId)
    && positiveInt(value.priceVersionId)
    && decimalText(value.sellPriceSnapshot)
    && boundedString(value.lineKey, 200)
    && value.lineKey.length > 0
    && boundedString(value.providerName, 300)
    && boundedString(value.offeringType, 120)
    && boundedString(value.providerReference, 500)
    && value.providerReference.length > 0
    && boundedString(value.providerBasketKey, 500)
    && value.providerBasketKey.length > 0
    && (value.faceValue === null || decimalText(value.faceValue))
    && (value.subscriptionDurationDays === null || positiveInt(value.subscriptionDurationDays))
    && typeof value.requiresStudentData === "boolean"
    && (value.student === undefined || isDigitalStudent(value.student));
}

function isOperationalPosRow(value: Record<string, unknown>, manualService: boolean): boolean {
  const idsValid = manualService
    ? value.variantId === 0 && value.productUnitId === 0
    : positiveInt(value.variantId) && positiveInt(value.productUnitId) && positiveInt(value.productId);
  return hasOnlyKeys(value, RECEPTION_PERSISTED_POS_ROW_KEYS) && idsValid
    && boundedString(value.productName, 500)
    && value.productName.trim().length > 0
    && boundedString(value.unitName, 120)
    && value.unitName.trim().length > 0
    && decimalText(value.conversionFactor, { positive: true })
    && decimalText(value.price)
    && finiteNumberInRange(value.stockBase, -1_000_000_000, 1_000_000_000)
    && typeof value.isService === "boolean"
    && typeof value.isPrintService === "boolean"
    && typeof value.isCustomizable === "boolean"
    && (value.availableBase === undefined || finiteNumberInRange(value.availableBase, -1_000_000_000, 1_000_000_000))
    && (value.allowBackorder === undefined || typeof value.allowBackorder === "boolean");
}

function isCart(value: unknown): value is CartLine[] {
  if (!Array.isArray(value) || value.length > 500 || containsSensitiveKey(value)) return false;
  return value.every((line) => {
    if (!isRecord(line)
      || !hasOnlyKeys(line, ["key", "row", "qty", "origPrice", "couponPriceSnapshot", "couponBasePromotion", "disc", "custom", "manualService", "digital"])
      || !boundedString(line.key, 200)
      || line.key.length === 0) return false;
    if (typeof line.qty !== "number" || !Number.isSafeInteger(line.qty) || line.qty <= 0 || line.qty > MAX_LINE_QUANTITY) return false;
    if (!isRecord(line.row)) return false;
    const manualService = line.manualService === true;
    if (line.manualService !== undefined && typeof line.manualService !== "boolean") return false;
    if (!isOperationalPosRow(line.row, manualService)) return false;
    if (line.origPrice !== undefined && !finiteNumberInRange(line.origPrice, 0, 1_000_000_000_000)) return false;
    if (line.couponPriceSnapshot !== undefined && !finiteNumberInRange(line.couponPriceSnapshot, 0, 1_000_000_000_000)) return false;
    if (line.couponBasePromotion !== undefined) {
      if (!isRecord(line.couponBasePromotion) || !hasOnlyKeys(line.couponBasePromotion, ["promotionId", "promotionName", "promotionEffectivePrice"])) return false;
      if (line.couponBasePromotion.promotionId !== null && (!Number.isSafeInteger(line.couponBasePromotion.promotionId) || Number(line.couponBasePromotion.promotionId) <= 0)) return false;
      if (line.couponBasePromotion.promotionName !== null && !boundedString(line.couponBasePromotion.promotionName, 200)) return false;
      if (line.couponBasePromotion.promotionEffectivePrice !== null && !decimalText(line.couponBasePromotion.promotionEffectivePrice)) return false;
    }
    if (line.disc !== undefined && !finiteNumberInRange(line.disc, 0, 100)) return false;
    if (line.custom !== undefined) {
      if (!isRecord(line.custom) || !isCustomization(line.custom)) return false;
    }
    if (manualService && line.custom === undefined) return false;
    if (line.digital !== undefined) {
      if (!isDigitalMeta(line.digital)
        || (line.digital as { lineKey: string }).lineKey !== line.key
        || line.qty !== 1
        || line.custom !== undefined) return false;
    }
    return true;
  });
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function validEnvelope(value: Record<string, unknown>, now: number): boolean {
  if (value.version !== RECEPTION_WORKSPACE_SCHEMA_VERSION) return false;
  if (!Number.isSafeInteger(value.savedAt) || !Number.isSafeInteger(value.expiresAt)) return false;
  const savedAt = Number(value.savedAt);
  const expiresAt = Number(value.expiresAt);
  if (savedAt > now + FUTURE_CLOCK_SKEW_MS) return false;
  if (expiresAt <= now || expiresAt !== savedAt + RECEPTION_WORKSPACE_TTL_MS) return false;
  return boundedString(value.clientRequestId, 64) && REQUEST_ID_RE.test(value.clientRequestId);
}

function validCustomer(value: unknown): value is ReceptionWorkspaceCustomer {
  return isRecord(value)
    && hasOnlyKeys(value, ["customerId", "name", "phone", "isNew"])
    && nullablePositiveInt(value.customerId)
    && boundedString(value.name, 300)
    && (value.phone === null || phoneInputText(value.phone))
    && typeof value.isNew === "boolean";
}

export function receptionWorkspaceStorageKey(
  companyId: number | null | undefined,
  userId: number | null | undefined,
  branchId: number | null | undefined,
): string | null {
  if (companyId === undefined || (companyId !== null && !positiveInt(companyId)) || !positiveInt(userId) || !positiveInt(branchId)) return null;
  const tenant = companyId === null ? "single" : `company:${companyId}`;
  return `${RECEPTION_WORKSPACE_STORAGE_PREFIX}v${RECEPTION_WORKSPACE_SCHEMA_VERSION}:tenant:${tenant}:user:${userId}:branch:${branchId}`;
}

export function legacyReceptionWorkspaceStorageKey(userId: number | null | undefined, branchId: number | null | undefined): string | null {
  return positiveInt(userId) && positiveInt(branchId) ? `${RECEPTION_WORKSPACE_STORAGE_PREFIX}v1:user:${userId}:branch:${branchId}` : null;
}

export function createReceptionLocalSnapshot(
  input: ReceptionLocalWorkspaceInput,
  now = Date.now(),
): ReceptionLocalWorkspaceSnapshot {
  const normalizedCart = input.cart.map((line) => ({
    ...line,
    row: {
      ...projectReceptionPersistedRow(line.row),
      isService: line.row.isService === true,
      isPrintService: line.row.isPrintService === true,
      isCustomizable: line.row.isCustomizable === true,
    },
  }));
  const safeCart = safePlainJson(normalizedCart);
  return {
    version: RECEPTION_WORKSPACE_SCHEMA_VERSION,
    kind: "LOCAL",
    savedAt: now,
    expiresAt: now + RECEPTION_WORKSPACE_TTL_MS,
    clientRequestId: input.clientRequestId,
    cart: (Array.isArray(safeCart) ? safeCart : []) as unknown as CartLine[],
    customer: { ...input.customer },
    phoneInput: input.phoneInput,
    customerCreditLimit: input.customerCreditLimit,
    tierOverride: input.tierOverride,
    effectiveTier: input.effectiveTier,
    draftPromotionPending: input.draftPromotionPending,
    draftPromotionShiftId: input.draftPromotionShiftId,
    detachedRecoveryPending: input.detachedRecoveryPending,
    payment: {
      amount: input.payInput,
      method: input.method,
      deferred: input.deferred,
    },
    invoiceDiscountPct: input.invoiceDiscountPct,
    coupon: {
      input: input.couponInput,
      code: input.couponCode,
      label: input.couponLabel,
    },
    channel: {
      kind: input.channel,
      handle: input.channelHandle,
      linkedConversationId: input.linkedConversationId,
    },
  };
}

function pinReceptionLocalPrices(snapshot: ReceptionLocalWorkspaceSnapshot): ReceptionLocalWorkspaceSnapshot {
  return {
    ...snapshot,
    cart: snapshot.cart.map((line) => {
      const couponPrice = snapshot.coupon.code && line.couponPriceSnapshot != null && !line.custom && !line.digital && !line.row.isPrintService
        ? Number(line.couponPriceSnapshot)
        : Number.NaN;
      if (Number.isFinite(couponPrice) && couponPrice >= 0) {
        const basePrice = line.origPrice ?? Number(line.couponBasePromotion?.promotionEffectivePrice ?? line.row.price ?? 0);
        return Number.isFinite(basePrice) && basePrice >= 0
          ? { ...line, row: { ...line.row, price: line.row.price == null ? String(basePrice) : line.row.price }, origPrice: basePrice, couponPriceSnapshot: couponPrice }
          : { ...line, couponPriceSnapshot: couponPrice };
      }
      const storedPrice = line.origPrice ?? (line.digital
        ? Number(line.digital.sellPriceSnapshot)
        : line.custom ? Number(line.row.price ?? 0) + Number(line.custom.unitPrice ?? 0) : Number(line.row.promotionEffectivePrice ?? line.row.price));
      return Number.isFinite(storedPrice) && storedPrice >= 0 ? { ...line, row: { ...line.row, price: line.row.price == null ? (line.custom ? "0" : String(storedPrice)) : line.row.price }, origPrice: storedPrice } : line;
    }),
  };
}

/** انتقال آمن وحيد من v1: محلياً فقط في نشر الشركة الواحدة؛ المؤشر الخادمي يُعاد جلبه بلا shadow. */
export function migrateReceptionWorkspaceV1(raw: string, now = Date.now()): ReceptionWorkspaceSnapshot | null {
  if (!isReceptionWorkspaceSnapshotSizeSafe(raw)) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.version !== 1 || !Number.isSafeInteger(value.savedAt) || !Number.isSafeInteger(value.expiresAt)
      || Number(value.savedAt) > now + FUTURE_CLOCK_SKEW_MS || Number(value.expiresAt) <= now
      || Number(value.expiresAt) !== Number(value.savedAt) + RECEPTION_WORKSPACE_TTL_MS
      || !boundedString(value.clientRequestId, 64) || !REQUEST_ID_RE.test(value.clientRequestId)) return null;
    if (value.kind === "SERVER_DRAFT") {
      if (!hasOnlyKeys(value, ["version", "kind", "savedAt", "expiresAt", "clientRequestId", "activeDraftId"]) || !positiveInt(value.activeDraftId)) return null;
      const pendingLocal = createReceptionLocalSnapshot({ clientRequestId: value.clientRequestId, cart: [], customer: { customerId: null, name: "", phone: null, isNew: false }, phoneInput: "", customerCreditLimit: "", tierOverride: null, effectiveTier: "RETAIL", draftPromotionPending: false, draftPromotionShiftId: null, detachedRecoveryPending: false, payInput: "", method: "CASH", deferred: false, invoiceDiscountPct: "", couponInput: "", couponCode: null, couponLabel: null, channel: "WALK_IN", channelHandle: "", linkedConversationId: null }, Number(value.savedAt));
      return { ...createReceptionDraftPointer({ activeDraftId: value.activeDraftId, draftVersion: 0, pendingLocal }), legacyIdentityOnly: true };
    }
    if (value.kind !== "LOCAL" || !hasOnlyKeys(value, ["version", "kind", "savedAt", "expiresAt", "clientRequestId", "cart", "customer", "phoneInput", "customerCreditLimit", "tierOverride", "payment", "invoiceDiscountPct", "coupon", "channel"])
      || !Array.isArray(value.cart) || !isRecord(value.customer) || !isRecord(value.payment) || !isRecord(value.coupon) || !isRecord(value.channel)) return null;
    const migrated = createReceptionLocalSnapshot({ clientRequestId: value.clientRequestId, cart: value.cart as CartLine[], customer: value.customer as unknown as ReceptionWorkspaceCustomer, phoneInput: value.phoneInput as string, customerCreditLimit: value.customerCreditLimit as string, tierOverride: value.tierOverride as Tier | null, effectiveTier: TIERS.has(value.tierOverride as Tier) ? value.tierOverride as Tier : "RETAIL", draftPromotionPending: false, draftPromotionShiftId: null, detachedRecoveryPending: false, payInput: value.payment.amount as string, method: value.payment.method as PayMethod, deferred: value.payment.deferred as boolean, invoiceDiscountPct: value.invoiceDiscountPct as string, couponInput: value.coupon.input as string, couponCode: value.coupon.code as string | null, couponLabel: value.coupon.label as string | null, channel: value.channel.kind as WorkOrderChannel, channelHandle: value.channel.handle as string, linkedConversationId: value.channel.linkedConversationId as number | null }, Number(value.savedAt));
    return parseReceptionWorkspaceSnapshot(serializeReceptionWorkspaceSnapshot(migrated), now);
  } catch { return null; }
}

export function createReceptionDraftPointer(
  input: { activeDraftId: number; draftVersion: number; pendingLocal: ReceptionLocalWorkspaceSnapshot },
): ReceptionServerDraftPointer {
  const pendingLocal = pinReceptionLocalPrices(input.pendingLocal);
  return {
    version: RECEPTION_WORKSPACE_SCHEMA_VERSION,
    kind: "SERVER_DRAFT",
    savedAt: pendingLocal.savedAt,
    expiresAt: pendingLocal.expiresAt,
    clientRequestId: pendingLocal.clientRequestId,
    activeDraftId: input.activeDraftId,
    draftVersion: input.draftVersion,
    pendingLocal,
  };
}

export function serializeReceptionWorkspaceSnapshot(snapshot: ReceptionWorkspaceSnapshot): string {
  return JSON.stringify(snapshot);
}

export function isReceptionWorkspaceSnapshotSizeSafe(raw: string): boolean {
  return raw.length > 0 && raw.length <= MAX_SERIALIZED_CHARS;
}

type ReceptionWorkspaceStorageWriter = Pick<Storage, "setItem" | "removeItem">;
type ReceptionWorkspaceStorageIndex = Pick<Storage, "length" | "key" | "removeItem">;
export type ReceptionWorkspaceWriteResult = "WRITTEN" | "INVALIDATED" | "STALE_REMAINS";
const activeReceptionPersistenceCancellers = new Set<() => void>();
let receptionWorkspaceBoundaryBlocked = false;

/** يوقف timers/flushes الحيّة قبل أن يمسح حدّ الجلسة التخزين. */
export function registerReceptionPersistenceCanceller(cancel: () => void): () => void {
  activeReceptionPersistenceCancellers.add(cancel);
  return () => activeReceptionPersistenceCancellers.delete(cancel);
}

export function cancelPendingReceptionWorkspaceWrites(): void {
  for (const cancel of Array.from(activeReceptionPersistenceCancellers)) cancel();
}

/**
 * كتابةٌ فاشلة لا يجوز أن تترك لقطةً أقدم تبدو كأنها آخر حالة. نحذف المفتاح عند تجاوز
 * الحجم أو quota/SecurityError؛ تبقى السلة الحيّة محروسة في الصفحة ويظهر التحذير للمستخدم.
 */
export function writeReceptionWorkspaceSnapshot(
  storage: ReceptionWorkspaceStorageWriter,
  key: string,
  raw: string,
): ReceptionWorkspaceWriteResult {
  if (!isReceptionWorkspaceSnapshotSizeSafe(raw) || parseReceptionWorkspaceSnapshot(raw) == null) {
    return clearReceptionWorkspaceSnapshot(storage, key) ? "INVALIDATED" : "STALE_REMAINS";
  }
  try {
    storage.setItem(key, raw);
    return "WRITTEN";
  } catch {
    return clearReceptionWorkspaceSnapshot(storage, key) ? "INVALIDATED" : "STALE_REMAINS";
  }
}

/** remove قد يُحجب منفرداً؛ tombstone فارغ يمنع بعث معرّف عملية ملتزمة عند إعادة التحميل. */
export function clearReceptionWorkspaceSnapshot(
  storage: ReceptionWorkspaceStorageWriter,
  key: string,
): boolean {
  try {
    storage.removeItem(key);
    return true;
  } catch {
    try {
      storage.setItem(key, "");
      return true;
    } catch {
      return false;
    }
  }
}

/** يثبّت v3 قبل إزالة v1 كي لا تعود الحالة القديمة بعد انقطاع بين الخطوتين. */
export function persistReceptionWorkspaceMigration(
  storage: ReceptionWorkspaceStorageWriter,
  targetKey: string,
  legacyKey: string,
  snapshot: ReceptionWorkspaceSnapshot,
): boolean {
  return writeReceptionWorkspaceSnapshot(storage, targetKey, serializeReceptionWorkspaceSnapshot(snapshot)) === "WRITTEN"
    && clearReceptionWorkspaceSnapshot(storage, legacyKey);
}

export function markReceptionWorkspaceBoundaryBlocked(): void {
  receptionWorkspaceBoundaryBlocked = true;
}

export function isReceptionWorkspaceBoundaryBlocked(storage: Pick<Storage, "getItem">): boolean {
  if (receptionWorkspaceBoundaryBlocked) return true;
  try { return storage.getItem(RECEPTION_WORKSPACE_BOUNDARY_BLOCK_KEY) === "1"; } catch { return true; }
}

/** عند حجب حدّ الهوية لا يكفي مسح مفتاح المستخدم الحالي؛ يجب نجاح تطهير النطاق كلّه. */
export function clearReceptionWorkspaceForUse(storage: Storage, key: string): boolean {
  return isReceptionWorkspaceBoundaryBlocked(storage)
    ? purgeReceptionWorkspaceSnapshots(storage)
    : clearReceptionWorkspaceSnapshot(storage, key);
}

function clearReceptionWorkspaceBoundaryBlock(storage: ReceptionWorkspaceStorageWriter): boolean {
  try {
    storage.removeItem(RECEPTION_WORKSPACE_BOUNDARY_BLOCK_KEY);
    receptionWorkspaceBoundaryBlocked = false;
    return true;
  } catch {
    receptionWorkspaceBoundaryBlocked = true;
    return false;
  }
}

/** حدّ تسجيل الدخول/الخروج يمسح كل إصدارات لقطات الاستقبال، بما فيها مفاتيح v1 القديمة. */
export function purgeReceptionWorkspaceSnapshots(storage: ReceptionWorkspaceStorageIndex & Partial<Pick<Storage, "setItem">>): boolean {
  cancelPendingReceptionWorkspaceWrites();
  const keys: string[] = [];
  let failed = false;
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(RECEPTION_WORKSPACE_STORAGE_PREFIX)) keys.push(key);
    }
  } catch { failed = true; }
  for (const key of keys) {
    try { storage.removeItem(key); } catch { failed = true; }
  }
  if (!failed && clearReceptionWorkspaceBoundaryBlock(storage as ReceptionWorkspaceStorageWriter)) return true;
  receptionWorkspaceBoundaryBlocked = true;
  try { storage.setItem?.(RECEPTION_WORKSPACE_BOUNDARY_BLOCK_KEY, "1"); } catch { /* حارس الذاكرة يبقى */ }
  return false;
}

export type ReceptionCartReconciliation =
  | { ok: true; cart: CartLine[] }
  | { ok: false; missingUnitIds: number[] };

/**
 * يستبدل بيانات الكتالوج المخزّنة بالحقيقة الحيّة. لا نحمل `origPrice` القديمة كـoverride؛
 * الخصم النسبيّ يبقى بنيّته فقط ويُعاد تأسيس مرجعه على السعر الحيّ. سعر الكرت الرقميّ يبقى
 * snapshot المزوّد وتتحقق منه مرحلة prepare لاحقاً، بينما بقية خصائص صفه تأتي من الكتالوج.
 */
export function reconcileReceptionCartRows(
  cart: readonly CartLine[],
  liveRows: readonly PosRow[],
  options: { preserveStoredPrices?: boolean } = {},
): ReceptionCartReconciliation {
  const byUnit = new Map(liveRows.map((row) => [Number(row.productUnitId), row]));
  const missing = Array.from(new Set(
    cart
      .filter((line) => {
        if (line.manualService === true) return false;
        const live = byUnit.get(Number(line.row.productUnitId));
        if (!live) return true;
        if (line.digital) return !(Number(line.digital.sellPriceSnapshot) > 0);
        if (options.preserveStoredPrices && line.origPrice != null && Number.isFinite(line.origPrice) && line.origPrice >= 0) return false;
        if (line.custom) {
          const customPrice = Number(live.price ?? 0) + Number(line.custom.unitPrice ?? 0);
          return !Number.isFinite(customPrice) || customPrice <= 0;
        }
        return live.price == null || !Number.isFinite(Number(live.price)) || Number(live.price) <= 0;
      })
      .map((line) => Number(line.row.productUnitId)),
  )).filter(positiveInt);
  if (missing.length > 0) return { ok: false, missingUnitIds: missing };

  const reconciled = cart.map((line): CartLine => {
    if (line.manualService === true) return line;
    const live = byUnit.get(Number(line.row.productUnitId))!;
    const row: PosRow = line.digital
      ? {
          ...live,
          price: line.digital.sellPriceSnapshot,
          isService: true,
          isPrintService: false,
          isCustomizable: false,
        }
      : live;
    const { origPrice: _staleOrigPrice, couponPriceSnapshot: _staleCouponPrice, couponBasePromotion: _staleCouponBase, ...rest } = line;
    const next: CartLine = options.preserveStoredPrices ? { ...line, row } : { ...rest, row };
    if (!options.preserveStoredPrices && (line.disc ?? 0) > 0) {
      const liveBase = line.custom
        ? Number(row.price) + Number(line.custom.unitPrice)
        : Number(row.promotionEffectivePrice ?? row.price);
      next.origPrice = liveBase;
    }
    return next;
  });
  return { ok: true, cart: reconciled };
}

export type ReceptionCouponPreview = {
  code: string;
  programName: string;
  lines: Array<{
    productUnitId: number;
    promotionId: number | null;
    promotionName: string | null;
    promotionEffectivePrice: string | null;
  }>;
};

export type ReceptionLocalRestorePreparation =
  | { ok: true; cart: CartLine[]; customer: ReceptionWorkspaceCustomer; tier: Tier; couponCode: string | null; couponLabel: string | null }
  | { ok: false; reason: "STALE" | "PRICING_CONTEXT" | "MISSING_CATALOG" | "NO_COUPON_LINES"; missingUnitIds?: number[] };

export function applyReceptionCouponPreview(
  cart: readonly CartLine[],
  coupon: ReceptionCouponPreview,
): CartLine[] {
  const byUnit = new Map(coupon.lines.map((line) => [Number(line.productUnitId), line]));
  return cart.map((item) => {
    const applied = !item.custom && !item.row.isPrintService && !item.digital
      ? byUnit.get(Number(item.row.productUnitId))
      : undefined;
    if (!applied) return item;
    const couponPrice = Number(applied.promotionEffectivePrice);
    return {
      ...item,
      ...(Number.isFinite(couponPrice) && couponPrice >= 0 ? { couponPriceSnapshot: couponPrice } : {}),
      couponBasePromotion: item.couponBasePromotion ?? {
        promotionId: item.row.promotionId ?? null,
        promotionName: item.row.promotionName ?? null,
        promotionEffectivePrice: item.row.promotionEffectivePrice ?? null,
      },
      row: { ...item.row, promotionId: applied.promotionId, promotionName: applied.promotionName, promotionEffectivePrice: applied.promotionEffectivePrice },
    };
  });
}

/** يزيل أثر الكوبون وحده ويُبقي السعر الأساس/الخصم اليدوي مستقلين. */
export function clearReceptionCouponPricing(cart: readonly CartLine[]): CartLine[] {
  return cart.map((line) => {
    if (line.custom || line.couponPriceSnapshot == null) return line;
    const { couponPriceSnapshot: _couponPrice, couponBasePromotion, ...rest } = line;
    return { ...rest, row: { ...line.row, promotionId: couponBasePromotion?.promotionId ?? null, promotionName: couponBasePromotion?.promotionName ?? null, promotionEffectivePrice: couponBasePromotion?.promotionEffectivePrice ?? null } };
  });
}

/** يجلب حقيقة الكتالوج/الكوبون ويعيد حالة مجهّزة؛ لا يلمس React قبل اكتمال كل التحقق. */
export async function prepareReceptionLocalWorkspaceRestore(
  snapshot: ReceptionLocalWorkspaceSnapshot,
  deps: {
    isCurrent: () => boolean;
    resolveAutomaticPricingContext: (input: {
      customer: ReceptionWorkspaceCustomer;
      phoneInput: string;
    }) => Promise<{ customer: ReceptionWorkspaceCustomer; tier: Tier }>;
    loadCatalog: (input: { productUnitIds: number[]; tier: Tier; customerId: number | null }) => Promise<PosRow[]>;
    previewCoupon: (input: {
      code: string;
      tier: Tier;
      customerId: number | null;
      lines: Array<{ productId: number; variantId: number; productUnitId: number; unitPrice: string; quantity: number; hasContractPrice: boolean }>;
    }) => Promise<ReceptionCouponPreview>;
    preserveStoredPrices?: boolean;
  },
): Promise<ReceptionLocalRestorePreparation> {
  const resolvedContext = await deps.resolveAutomaticPricingContext({ customer: snapshot.customer, phoneInput: snapshot.phoneInput });
  const pricingContext = { customer: resolvedContext.customer, tier: snapshot.tierOverride ?? resolvedContext.tier };
  if (!deps.isCurrent()) return { ok: false, reason: "STALE" };
  if (!TIERS.has(pricingContext.tier) || !validCustomer(pricingContext.customer)) return { ok: false, reason: "PRICING_CONTEXT" };
  const productUnitIds = Array.from(new Set(snapshot.cart
    .filter((line) => line.manualService !== true)
    .map((line) => Number(line.row.productUnitId))));
  const liveRows = productUnitIds.length > 0
    ? await deps.loadCatalog({ productUnitIds, tier: pricingContext.tier, customerId: pricingContext.customer.customerId })
    : [];
  if (!deps.isCurrent()) return { ok: false, reason: "STALE" };
  const reconciled = reconcileReceptionCartRows(snapshot.cart, liveRows, { preserveStoredPrices: deps.preserveStoredPrices });
  if (!reconciled.ok) return { ok: false, reason: "MISSING_CATALOG", missingUnitIds: reconciled.missingUnitIds };
  if (deps.preserveStoredPrices) return { ok: true, cart: reconciled.cart, customer: pricingContext.customer, tier: pricingContext.tier, couponCode: snapshot.coupon.code, couponLabel: snapshot.coupon.label };
  if (!snapshot.coupon.code) return { ok: true, cart: reconciled.cart, customer: pricingContext.customer, tier: pricingContext.tier, couponCode: null, couponLabel: null };

  const eligible = reconciled.cart.filter((line) => !line.custom && !line.row.isPrintService && !line.digital);
  if (eligible.length === 0) return { ok: false, reason: "NO_COUPON_LINES" };
  const coupon = await deps.previewCoupon({
    code: snapshot.coupon.code,
    tier: pricingContext.tier,
    customerId: pricingContext.customer.customerId,
    lines: eligible.map((line) => ({
      productId: line.row.productId,
      variantId: line.row.variantId,
      productUnitId: line.row.productUnitId,
      unitPrice: String(line.row.price),
      quantity: line.qty,
      hasContractPrice: !!line.row.isContractPrice,
    })),
  });
  if (!deps.isCurrent()) return { ok: false, reason: "STALE" };
  return {
    ok: true,
    cart: applyReceptionCouponPreview(reconciled.cart, coupon),
    customer: pricingContext.customer,
    tier: pricingContext.tier,
    couponCode: coupon.code,
    couponLabel: coupon.programName,
  };
}

export type ReceptionRestorableDraftLine = {
  id: number;
  quantity: number | string;
  lineKind: string;
  printSpec: string | null;
  designImages: string | null;
  variantId: number | null;
  productUnitId: number | null;
  title: string | null;
  unitPrice: number | string;
};

export type ReceptionDraftCartPreparation =
  | { ok: true; cart: CartLine[] }
  | { ok: false; missingCount: number };

/** يصون السعر الأساس التاريخي للمسوّدة، مع السماح بتعديل إضافة التخصيص بعد الاستئناف. */
export function updateRestoredReceptionCustomization(line: CartLine, custom: CustomizationData): CartLine {
  if (line.origPrice == null) return { ...line, custom };
  const previousAddon = Number(line.custom?.unitPrice ?? 0);
  const nextAddon = Number(custom.unitPrice || 0);
  if (!Number.isFinite(previousAddon) || !Number.isFinite(nextAddon)) return { ...line, custom };
  return { ...line, custom, origPrice: Math.max(0, line.origPrice - previousAddon + nextAddon) };
}

function emptyRestoredCustomization(title: string): CustomizationData {
  return {
    title: title.trim() === "خدمة / أمر شغل" ? "" : title,
    unitPrice: "0",
    laborCost: "0",
    assignedTo: null,
    size: "",
    material: "",
    customizationText: "",
    priority: "NORMAL",
    dueDate: "",
    hasDelivery: false,
    deliveryAddress: "",
    deliveryPhone: "",
    deliveryCost: "0",
    deliveryFeeCollection: "COURIER",
    designImages: [],
    paymentReceiptImages: [],
    deposit: "0",
  };
}

/** يبني سلة مسوّدة كاملة خارج الحالة؛ لا commit جزئياً إذا اختفى أي بند كتالوج. */
export function prepareReceptionDraftCart(
  lines: readonly ReceptionRestorableDraftLine[],
  liveRows: readonly PosRow[],
): ReceptionDraftCartPreparation {
  const byUnit = new Map(liveRows.map((row) => [Number(row.productUnitId), row]));
  let missingCount = 0;
  const cart: CartLine[] = [];
  for (const line of lines) {
    const quantity = Number(line.quantity);
    if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > MAX_LINE_QUANTITY) { missingCount += 1; continue; }
    if (line.lineKind === "CUSTOM") {
      const liveRow = byUnit.get(Number(line.productUnitId));
      if (line.variantId != null && !liveRow) { missingCount += 1; continue; }
      let spec: unknown = {};
      let images: unknown = [];
      try { spec = line.printSpec ? JSON.parse(line.printSpec) : {}; } catch { missingCount += 1; continue; }
      try { images = line.designImages ? JSON.parse(line.designImages) : []; } catch { missingCount += 1; continue; }
      if (!isRecord(spec) || !Array.isArray(images) || !images.every((image) => isRecord(image) && boundedString(image.url, 8_000_000) && image.url.startsWith("data:image/") && (image.caption == null || boundedString(image.caption, 500)))) {
        missingCount += 1; continue;
      }
      const safeImages = images as Array<{ url: string; caption?: string | null }>;
      const customCandidate = {
        ...emptyRestoredCustomization(line.title ?? ""),
        ...spec,
        designImages: safeImages.map((image, index) => ({ id: `r-${line.id}-${index}`, dataUrl: image.url, name: image.caption ?? undefined, isPrimary: index === 0 })),
        paymentReceiptImages: [],
      };
      if (!isCustomization(customCandidate)) { missingCount += 1; continue; }
      const custom = customCandidate as CustomizationData;
      const row = liveRow ?? ({
        variantId: Number(line.variantId ?? 0), productUnitId: Number(line.productUnitId ?? 0),
        productName: line.title ?? "خدمة / أمر شغل", sku: "SERVICE", unitName: "خدمة",
        conversionFactor: "1", price: "0", stockBase: 0,
        isService: true, isPrintService: false, isCustomizable: true,
      } as PosRow);
      const restored: CartLine = { key: `r-${line.id}`, row, qty: quantity, custom, manualService: line.variantId == null };
      const storedPrice = Number(line.unitPrice);
      if (Number.isFinite(storedPrice) && storedPrice >= 0) restored.origPrice = storedPrice;
      cart.push(restored);
      continue;
    }
    const row = byUnit.get(Number(line.productUnitId));
    if (!row) { missingCount += 1; continue; }
    const restored: CartLine = { key: `r-${line.id}`, row, qty: quantity };
    const storedPrice = Number(line.unitPrice);
    if (!Number.isFinite(storedPrice) || storedPrice < 0 || storedPrice > MAX_MONEY) { missingCount += 1; continue; }
    if (storedPrice !== Number(row.promotionEffectivePrice ?? row.price ?? 0)) restored.origPrice = storedPrice;
    cart.push(restored);
  }
  return missingCount > 0 ? { ok: false, missingCount } : { ok: true, cart };
}

export function parseReceptionWorkspaceSnapshot(
  raw: string | null,
  now = Date.now(),
): ReceptionWorkspaceSnapshot | null {
  if (raw == null || !isReceptionWorkspaceSnapshotSizeSafe(raw)) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || containsSensitiveKey(value) || !validEnvelope(value, now)) return null;

  if (value.kind === "SERVER_DRAFT") {
    if (!hasOnlyKeys(value, ["version", "kind", "savedAt", "expiresAt", "clientRequestId", "activeDraftId", "draftVersion", "pendingLocal", "legacyIdentityOnly"])) {
      return null;
    }
    if (!positiveInt(value.activeDraftId) || !Number.isSafeInteger(value.draftVersion) || Number(value.draftVersion) < 0 || !isRecord(value.pendingLocal)
      || (value.legacyIdentityOnly !== undefined && value.legacyIdentityOnly !== true)) return null;
    const pendingLocal = parseReceptionWorkspaceSnapshot(JSON.stringify(value.pendingLocal), now);
    if (pendingLocal?.kind !== "LOCAL"
      || pendingLocal.clientRequestId !== value.clientRequestId
      || pendingLocal.savedAt !== value.savedAt
      || pendingLocal.expiresAt !== value.expiresAt) return null;
    return value as ReceptionServerDraftPointer;
  }

  if (value.kind !== "LOCAL") return null;
  if (!hasOnlyKeys(value, [
    "version",
    "kind",
    "savedAt",
    "expiresAt",
    "clientRequestId",
    "cart",
    "customer",
    "phoneInput",
    "customerCreditLimit",
    "tierOverride",
    "effectiveTier",
    "draftPromotionPending",
    "draftPromotionShiftId",
    "detachedRecoveryPending",
    "payment",
    "invoiceDiscountPct",
    "coupon",
    "channel",
  ])) return null;
  if (!isCart(value.cart) || !validCustomer(value.customer)) return null;
  if (!phoneInputText(value.phoneInput)) return null;
  if (!optionalDecimalText(value.customerCreditLimit)) return null;
  if (value.tierOverride !== null && !TIERS.has(value.tierOverride as Tier)) return null;
  if (!TIERS.has(value.effectiveTier as Tier)) return null;
  if (typeof value.draftPromotionPending !== "boolean") return null;
  if (!nullablePositiveInt(value.draftPromotionShiftId)) return null;
  if (typeof value.detachedRecoveryPending !== "boolean") return null;
  if (!isRecord(value.payment)
    || !hasOnlyKeys(value.payment, ["amount", "method", "deferred"])
    || !optionalDecimalText(value.payment.amount)
    || !PAY_METHODS.has(value.payment.method as PayMethod)
    || typeof value.payment.deferred !== "boolean") return null;
  if (!optionalDecimalText(value.invoiceDiscountPct, { max: 100 })) return null;
  if (!isRecord(value.coupon)
    || !hasOnlyKeys(value.coupon, ["input", "code", "label"])
    || !boundedString(value.coupon.input, 100)
    || !nullableBoundedString(value.coupon.code, 100)
    || !nullableBoundedString(value.coupon.label, 300)) return null;
  if (!isRecord(value.channel)
    || !hasOnlyKeys(value.channel, ["kind", "handle", "linkedConversationId"])
    || !CHANNELS.has(value.channel.kind as WorkOrderChannel)
    || !boundedString(value.channel.handle, 200)
    || !nullablePositiveInt(value.channel.linkedConversationId)) return null;

    return value as ReceptionLocalWorkspaceSnapshot;
  } catch {
    return null;
  }
}

/** بصمة المحتوى وحده؛ تجديد مهلة اللقطة لا يُعدّ تغييراً تشغيلياً. */
export function receptionWorkspaceFingerprint(snapshot: ReceptionWorkspaceSnapshot): string {
  const { savedAt: _savedAt, expiresAt: _expiresAt, ...content } = snapshot;
  return JSON.stringify(content);
}

function nonZeroText(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  const numeric = Number(trimmed.replace(/,/g, ""));
  return !Number.isFinite(numeric) || numeric !== 0;
}

export function isReceptionWorkspaceDirty(input: ReceptionWorkspaceDirtyInput): boolean {
  return input.cartLength > 0
    || input.customerId != null
    || input.customerName.trim().length > 0
    || (input.customerPhone?.trim().length ?? 0) > 0
    || input.customerIsNew
    || input.phoneInput.trim().length > 0
    || input.customerCreditLimit.trim().length > 0
    || input.tierOverride != null
    || nonZeroText(input.payInput)
    || input.method !== "CASH"
    || input.paymentReference.trim().length > 0
    || input.deferred
    || nonZeroText(input.invoiceDiscountPct)
    || input.couponInput.trim().length > 0
    || input.couponCode != null
    || input.couponLabel != null
    || input.channel !== "WALK_IN"
    || input.channelHandle.trim().length > 0
    || input.linkedConversationId != null
    || input.activeDraftId != null
    || nonZeroText(input.draftHeld);
}

export type ReceptionWorkspacePersistenceOptions = {
  /** `null` = نشر أحادي الشركة، `undefined` = الهوية لم تُحسم بعد. */
  companyId: number | null | undefined;
  userId: number | null;
  branchId: number | null;
  activeDraftId: number | null;
  activeDraftVersion: number | null;
  clientRequestIdRef: { current: string };
  local: Omit<ReceptionLocalWorkspaceInput, "clientRequestId">;
  paymentReference: string;
  draftHeld: string;
  onRestoreLocal: (snapshot: ReceptionLocalWorkspaceSnapshot, isCurrent: () => boolean) => Promise<boolean>;
  onRestoreServerDraft: (snapshot: ReceptionServerDraftPointer, isCurrent: () => boolean) => Promise<boolean>;
  onWorkspaceChange: () => void;
  onStorageError?: () => void;
};

export type ReceptionWorkspaceLifecycleState = "READY" | "HYDRATING" | "BLOCKED";

/**
 * دورة التخزين وحدها؛ تبقى قواعد الشكل/التحقّق أعلاه نقية وقابلة للاختبار. لا تعيد hydration
 * لنفس user+branch، ولا تسمح لأثر الكتابة بالعمل قبل انتهاء الاستعادة.
 */
export function useReceptionWorkspacePersistence(
  options: ReceptionWorkspacePersistenceOptions,
): { clearPersistedWorkspace: (persistCurrent?: boolean) => boolean; markDraftPromotionPending: (shiftId: number | null) => boolean; workspaceState: ReceptionWorkspaceLifecycleState; workspaceDirty: boolean; persistenceDegraded: boolean } {
  const storageKey = useMemo(
    () => receptionWorkspaceStorageKey(options.companyId, options.userId, options.branchId),
    [options.branchId, options.companyId, options.userId],
  );
  const retainedDraftIdRef = useRef<number | null>(null);
  const retainedDraftVersionRef = useRef<number | null>(null);
  const previousActiveDraftIdRef = useRef(options.activeDraftId);
  const effectiveDraftId = options.activeDraftId ?? retainedDraftIdRef.current;
  const effectiveDraftVersion = options.activeDraftVersion ?? retainedDraftVersionRef.current;
  const workspaceDirty = isReceptionWorkspaceDirty({
    cartLength: options.local.cart.length,
    customerId: options.local.customer.customerId,
    customerName: options.local.customer.name,
    customerPhone: options.local.customer.phone,
    customerIsNew: options.local.customer.isNew,
    phoneInput: options.local.phoneInput,
    customerCreditLimit: options.local.customerCreditLimit,
    tierOverride: options.local.tierOverride,
    payInput: options.local.payInput,
    method: options.local.method,
    paymentReference: options.paymentReference,
    deferred: options.local.deferred,
    invoiceDiscountPct: options.local.invoiceDiscountPct,
    couponInput: options.local.couponInput,
    couponCode: options.local.couponCode,
    couponLabel: options.local.couponLabel,
    channel: options.local.channel,
    channelHandle: options.local.channelHandle,
    linkedConversationId: options.local.linkedConversationId,
    activeDraftId: effectiveDraftId,
    draftHeld: options.draftHeld,
  });
  useUnsavedGuard(workspaceDirty);
  const [hydratedKey, setHydratedKey] = useState<string | null>(null);
  const [blockedKey, setBlockedKey] = useState<string | null>(null);
  const [degradedKey, setDegradedKey] = useState<string | null>(null);
  const blockedKeyRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistedFingerprintRef = useRef<string | null>(null);
  const suppressNextPersistRef = useRef<string | null>(null);
  const warningShownRef = useRef(false);
  const pendingWriteRef = useRef<{ key: string; raw: string; fingerprint: string } | null>(null);
  const persistenceDisabledRef = useRef(false);
  const sessionBoundaryCancelledRef = useRef(false);
  const lastStorageKeyRef = useRef<string | null>(null);
  const completedHydrationKeyRef = useRef<string | null>(null);
  const hydrationEpochRef = useRef(0);
  const restoreLocalRef = useRef(options.onRestoreLocal);
  const restoreDraftRef = useRef(options.onRestoreServerDraft);
  const resetWorkspaceRef = useRef(options.onWorkspaceChange);
  const storageErrorRef = useRef(options.onStorageError);
  const latestLocalRef = useRef(options.local);
  restoreLocalRef.current = options.onRestoreLocal;
  restoreDraftRef.current = options.onRestoreServerDraft;
  resetWorkspaceRef.current = options.onWorkspaceChange;
  storageErrorRef.current = options.onStorageError;
  latestLocalRef.current = options.local;

  const degradePersistence = useCallback((key: string) => {
    persistenceDisabledRef.current = true;
    persistedFingerprintRef.current = null;
    pendingWriteRef.current = null;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setDegradedKey(key);
    if (!warningShownRef.current) { warningShownRef.current = true; storageErrorRef.current?.(); }
  }, []);

  const blockPersistence = useCallback((key: string) => {
    persistenceDisabledRef.current = true;
    persistedFingerprintRef.current = null;
    pendingWriteRef.current = null;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    blockedKeyRef.current = key;
    setBlockedKey(key);
    if (!warningShownRef.current) { warningShownRef.current = true; storageErrorRef.current?.(); }
  }, []);

  const flushPendingWrite = useCallback(() => {
    const pending = pendingWriteRef.current;
    if (sessionBoundaryCancelledRef.current || persistenceDisabledRef.current || !pending || blockedKeyRef.current === pending.key || typeof window === "undefined") return;
    let storage: Storage | null = null;
    try { storage = window.sessionStorage; } catch { /* يُحجب أدناه */ }
    const result = storage ? writeReceptionWorkspaceSnapshot(storage, pending.key, pending.raw) : "STALE_REMAINS";
    if (result === "WRITTEN") {
      persistedFingerprintRef.current = pending.fingerprint;
      pendingWriteRef.current = null;
      warningShownRef.current = false;
    } else if (result === "INVALIDATED") {
      degradePersistence(pending.key);
    } else {
      blockPersistence(pending.key);
    }
  }, [blockPersistence, degradePersistence]);

  const clearPersistedWorkspace = useCallback((persistCurrent = false): boolean => {
    if (sessionBoundaryCancelledRef.current) return false;
    hydrationEpochRef.current += 1;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    pendingWriteRef.current = null;
    retainedDraftIdRef.current = null;
    retainedDraftVersionRef.current = null;
    if (!storageKey || typeof window === "undefined") return true;
    let storage: Storage | null = null;
    try { storage = window.sessionStorage; } catch { /* يُحجب أدناه */ }
    if (!storage || !clearReceptionWorkspaceForUse(storage, storageKey)) {
      suppressNextPersistRef.current = null;
      blockedKeyRef.current = storageKey;
      setBlockedKey(storageKey);
      if (!warningShownRef.current) { warningShownRef.current = true; storageErrorRef.current?.(); }
      return false;
    }
    persistenceDisabledRef.current = false;
    persistedFingerprintRef.current = null;
    // لا تعِد كتابة الحالة التي اختار الموظف مسحها في أول رسم يلي reset/clear.
    suppressNextPersistRef.current = persistCurrent ? null : storageKey;
    blockedKeyRef.current = null;
    setBlockedKey(null);
    setDegradedKey(null);
    setHydratedKey(storageKey);
    return true;
  }, [storageKey]);

  const markDraftPromotionPending = useCallback((shiftId: number | null): boolean => {
    if (sessionBoundaryCancelledRef.current || !storageKey || typeof window === "undefined" || blockedKeyRef.current === storageKey) return false;
    const snapshot = pinReceptionLocalPrices(createReceptionLocalSnapshot({ ...latestLocalRef.current, clientRequestId: options.clientRequestIdRef.current, draftPromotionPending: true, draftPromotionShiftId: shiftId }));
    const raw = serializeReceptionWorkspaceSnapshot(snapshot);
    let storage: Storage | null = null;
    try { storage = window.sessionStorage; } catch { /* يعالج أدناه */ }
    const result = storage ? writeReceptionWorkspaceSnapshot(storage, storageKey, raw) : "STALE_REMAINS";
    if (result !== "WRITTEN") { if (result === "INVALIDATED") degradePersistence(storageKey); else blockPersistence(storageKey); return false; }
    persistenceDisabledRef.current = false; setDegradedKey(null); persistedFingerprintRef.current = receptionWorkspaceFingerprint(snapshot); pendingWriteRef.current = null; warningShownRef.current = false;
    return true;
  }, [blockPersistence, degradePersistence, options.clientRequestIdRef, storageKey]);

  useEffect(() => registerReceptionPersistenceCanceller(() => {
    sessionBoundaryCancelledRef.current = true;
    persistenceDisabledRef.current = true;
    completedHydrationKeyRef.current = null;
    hydrationEpochRef.current += 1;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    pendingWriteRef.current = null;
  }), []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const flush = () => flushPendingWrite();
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flushPendingWrite();
    };
  }, [flushPendingWrite]);

  useEffect(() => {
    const previous = previousActiveDraftIdRef.current;
    if (options.activeDraftId != null) {
      retainedDraftIdRef.current = options.activeDraftId;
      retainedDraftVersionRef.current = options.activeDraftVersion;
    } else if (previous != null && retainedDraftIdRef.current != null && storageKey && hydratedKey === storageKey) {
      // انفصلت مسوّدة خادمية بلا clear صريح (عادةً أُغلقت من جهاز آخر): لا تحوّل سلتها
      // تلقائياً إلى LOCAL قابلة للبيع ثانيةً؛ احجبها حتى يفرّغها الموظف صراحةً.
      blockedKeyRef.current = storageKey;
      setBlockedKey(storageKey);
    }
    previousActiveDraftIdRef.current = options.activeDraftId;
  }, [hydratedKey, options.activeDraftId, options.activeDraftVersion, storageKey]);

  useEffect(() => {
    let cancelled = false;
    const epoch = ++hydrationEpochRef.current;
    const key = storageKey;
    const isCurrent = () => !cancelled && hydrationEpochRef.current === epoch;
    if (key && completedHydrationKeyRef.current === key) {
      setHydratedKey(key);
      return () => { cancelled = true; };
    }
    flushPendingWrite();
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    pendingWriteRef.current = null;
    persistedFingerprintRef.current = null;
    suppressNextPersistRef.current = null;
    setHydratedKey(null);
    blockedKeyRef.current = null;
    setBlockedKey(null);
    setDegradedKey(null);
    const previousKey = lastStorageKeyRef.current;
    if (previousKey && key && previousKey !== key) {
      sessionBoundaryCancelledRef.current = false;
      persistenceDisabledRef.current = false;
      completedHydrationKeyRef.current = null;
      retainedDraftIdRef.current = null;
      retainedDraftVersionRef.current = null;
      options.clientRequestIdRef.current = crypto.randomUUID();
      resetWorkspaceRef.current();
    }
    if (!key || typeof window === "undefined") return () => { cancelled = true; };
    lastStorageKeyRef.current = key;

    let migratedFromLegacy = false;
    const finish = () => {
      if (!isCurrent()) return;
      completedHydrationKeyRef.current = key;
      suppressNextPersistRef.current = migratedFromLegacy ? null : key;
      blockedKeyRef.current = null;
      setBlockedKey(null);
      setHydratedKey(key);
    };

    let raw: string | null = null;
    let migratedSnapshot: ReceptionWorkspaceSnapshot | null = null;
    let storage: Storage;
    try {
      storage = window.sessionStorage;
      if (isReceptionWorkspaceBoundaryBlocked(storage)) throw new DOMException("blocked session boundary", "SecurityError");
      raw = storage.getItem(key);
    } catch {
      blockedKeyRef.current = key;
      setBlockedKey(key);
      if (!warningShownRef.current) { warningShownRef.current = true; storageErrorRef.current?.(); }
      return () => { cancelled = true; };
    }
    if (raw == null) {
      const legacyKey = legacyReceptionWorkspaceStorageKey(options.userId, options.branchId);
      let legacyRaw: string | null = null;
      try { legacyRaw = legacyKey ? storage.getItem(legacyKey) : null; } catch { /* يعالج كحد تخزين أدناه */ }
      if (legacyRaw != null && options.companyId !== null) {
        receptionWorkspaceBoundaryBlocked = true;
        try { storage.setItem(RECEPTION_WORKSPACE_BOUNDARY_BLOCK_KEY, "1"); } catch { /* حارس الذاكرة يبقى */ }
        blockedKeyRef.current = key; setBlockedKey(key);
        if (!warningShownRef.current) { warningShownRef.current = true; storageErrorRef.current?.(); }
        return () => { cancelled = true; };
      }
      migratedSnapshot = legacyRaw == null ? null : migrateReceptionWorkspaceV1(legacyRaw);
      if (!migratedSnapshot) {
        if (legacyRaw != null && legacyKey && !clearReceptionWorkspaceSnapshot(storage, legacyKey)) { blockPersistence(key); return () => { cancelled = true; }; }
        finish(); return () => { cancelled = true; };
      }
      if (!legacyKey || !persistReceptionWorkspaceMigration(storage, key, legacyKey, migratedSnapshot)) {
        blockPersistence(key); return () => { cancelled = true; };
      }
      migratedFromLegacy = true;
    }
    const snapshot = migratedSnapshot ?? parseReceptionWorkspaceSnapshot(raw);
    if (!snapshot) {
      if (!clearReceptionWorkspaceSnapshot(storage, key)) {
        blockedKeyRef.current = key; setBlockedKey(key);
        if (!warningShownRef.current) { warningShownRef.current = true; storageErrorRef.current?.(); }
        return () => { cancelled = true; };
      }
      finish();
      return () => { cancelled = true; };
    }

    options.clientRequestIdRef.current = snapshot.clientRequestId;
    if (snapshot.kind === "SERVER_DRAFT") {
      retainedDraftIdRef.current = snapshot.activeDraftId;
      retainedDraftVersionRef.current = snapshot.draftVersion;
      // المؤشر وحده يُستعاد من الخادم. فشل النقل يحجب التحرير حتى إعادة المحاولة أو مسحٍ صريح.
      void restoreDraftRef.current(snapshot, isCurrent).then((restored) => {
        if (!isCurrent()) return;
        if (restored) finish();
        else { blockedKeyRef.current = key; setBlockedKey(key); }
      }).catch(() => { if (isCurrent()) { blockedKeyRef.current = key; setBlockedKey(key); } });
    } else {
      retainedDraftIdRef.current = null;
      void restoreLocalRef.current(snapshot, isCurrent).then((restored) => {
        if (!isCurrent()) return;
        if (restored) finish();
        else { blockedKeyRef.current = key; setBlockedKey(key); }
      }).catch(() => { if (isCurrent()) { blockedKeyRef.current = key; setBlockedKey(key); } });
    }
    return () => { cancelled = true; };
  }, [flushPendingWrite, options.clientRequestIdRef, storageKey]);

  const clientRequestId = options.clientRequestIdRef.current;
  const persisted = useMemo(() => {
    const currentLocal = createReceptionLocalSnapshot({
      clientRequestId,
      cart: options.local.cart,
      customer: {
        customerId: options.local.customer.customerId,
        name: options.local.customer.name,
        phone: options.local.customer.phone,
        isNew: options.local.customer.isNew,
      },
      phoneInput: options.local.phoneInput,
      customerCreditLimit: options.local.customerCreditLimit,
      tierOverride: options.local.tierOverride,
      effectiveTier: options.local.effectiveTier,
      draftPromotionPending: options.local.draftPromotionPending,
      draftPromotionShiftId: options.local.draftPromotionShiftId,
      detachedRecoveryPending: options.local.detachedRecoveryPending,
      payInput: options.local.payInput,
      method: options.local.method,
      deferred: options.local.deferred,
      invoiceDiscountPct: options.local.invoiceDiscountPct,
      couponInput: options.local.couponInput,
      couponCode: options.local.couponCode,
      couponLabel: options.local.couponLabel,
      channel: options.local.channel,
      channelHandle: options.local.channelHandle,
      linkedConversationId: options.local.linkedConversationId,
    });
    const pendingLocal = options.local.draftPromotionPending || options.local.detachedRecoveryPending ? pinReceptionLocalPrices(currentLocal) : currentLocal;
    const snapshot = effectiveDraftId != null
      ? createReceptionDraftPointer({ activeDraftId: effectiveDraftId, draftVersion: effectiveDraftVersion ?? 0, pendingLocal })
      : pendingLocal;
    return {
      fingerprint: receptionWorkspaceFingerprint(snapshot),
      serialized: serializeReceptionWorkspaceSnapshot(snapshot),
    };
  }, [
    clientRequestId,
    effectiveDraftId,
    effectiveDraftVersion,
    options.local.cart,
    options.local.channel,
    options.local.channelHandle,
    options.local.couponCode,
    options.local.couponInput,
    options.local.couponLabel,
    options.local.customer.customerId,
    options.local.customer.isNew,
    options.local.customer.name,
    options.local.customer.phone,
    options.local.customerCreditLimit,
    options.local.deferred,
    options.local.effectiveTier,
    options.local.draftPromotionPending,
    options.local.draftPromotionShiftId,
    options.local.detachedRecoveryPending,
    options.local.invoiceDiscountPct,
    options.local.linkedConversationId,
    options.local.method,
    options.local.payInput,
    options.local.phoneInput,
    options.local.tierOverride,
  ]);

  useEffect(() => {
    const key = storageKey;
    if (sessionBoundaryCancelledRef.current || persistenceDisabledRef.current || !key || blockedKey === key || blockedKeyRef.current === key || hydratedKey !== key || typeof window === "undefined") return;
    if (!isReceptionWorkspaceSnapshotSizeSafe(persisted.serialized)) {
      pendingWriteRef.current = null;
      let invalidated = false;
      try { invalidated = clearReceptionWorkspaceSnapshot(window.sessionStorage, key); } catch { /* تُحجب أدناه */ }
      persistedFingerprintRef.current = null;
      if (invalidated) degradePersistence(key); else blockPersistence(key);
      return;
    }
    if (suppressNextPersistRef.current === key) {
      suppressNextPersistRef.current = null;
      persistedFingerprintRef.current = persisted.fingerprint;
      pendingWriteRef.current = null;
      return;
    }
    if (persistedFingerprintRef.current === persisted.fingerprint) {
      // أُلغي تغيّرٌ سريع قبل انتهاء مهلة الكتابة؛ لا تدع pagehide يعيد لقطةً وسيطة قديمة.
      pendingWriteRef.current = null;
      return;
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    pendingWriteRef.current = { key, raw: persisted.serialized, fingerprint: persisted.fingerprint };
    if (effectiveDraftId != null) {
      flushPendingWrite();
      return;
    }
    timerRef.current = setTimeout(() => {
      const pending = pendingWriteRef.current;
      if (sessionBoundaryCancelledRef.current || persistenceDisabledRef.current || !pending || blockedKeyRef.current === pending.key) return;
      let storage: Storage | null = null;
      try { storage = window.sessionStorage; } catch { /* يُحجب أدناه */ }
      const result = storage ? writeReceptionWorkspaceSnapshot(storage, pending.key, pending.raw) : "STALE_REMAINS";
      if (result === "WRITTEN") {
        persistedFingerprintRef.current = pending.fingerprint;
        pendingWriteRef.current = null;
        warningShownRef.current = false;
      } else if (result === "INVALIDATED") {
        degradePersistence(pending.key);
      } else {
        blockPersistence(pending.key);
      }
    }, 300);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [blockedKey, blockPersistence, degradePersistence, effectiveDraftId, flushPendingWrite, hydratedKey, persisted, storageKey]);

  const detachedDraft = storageKey != null
    && hydratedKey === storageKey
    && previousActiveDraftIdRef.current != null
    && options.activeDraftId == null
    && retainedDraftIdRef.current != null;
  const workspaceState: ReceptionWorkspaceLifecycleState = (storageKey != null && blockedKey === storageKey) || detachedDraft
    ? "BLOCKED"
    : !storageKey || hydratedKey === storageKey
      ? "READY"
      : "HYDRATING";
  return { clearPersistedWorkspace, markDraftPromotionPending, workspaceState, workspaceDirty, persistenceDegraded: storageKey != null && degradedKey === storageKey };
}
