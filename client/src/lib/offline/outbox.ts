// طابور المبيعات الأوفلاينية — الشريحة ٣ من خطة الأوفلاين (تعميم نمط countQueue على Dexie).
//
// الالتقاط: بيع نقدي كامل يُحفظ محلياً بعنصر يحمل clientRequestId الثابت نفسه الذي كان
// سيستعمله البيع أونلاين ⇒ الترحيل عبر offline.replaySale يمرّ بفحص uq_invoice_source
// وبصمة السلة في createSale — التكرار آمن دائماً حتى مع بيعٍ نصف-ناجح قبل الانقطاع.
//
// التفريغ: FIFO بترتيب الالتقاط، طلب واحد بالطيران، تراجع أُسّي 1ث→60ث على فشل النقل.
// رفض الأعمال (فترة مقفلة/تحت التكلفة/وردية مغلقة/نافذة الالتقاط) ⇒ العنصر يُعلَّق PARKED
// ويُكمل التفريغ للعنصر التالي — عنصر معطوب لا يحجب النقود التي بعده. UNAUTHORIZED يوقف
// التفريغ كله (يلزم دخول) بلا تعليق العناصر — الطابور مربوط بالجهاز لا بالجلسة.
//
// صماما أمان (نهج Square): سقف قيمة للطابور (حدّ أقصى معلوم للمبالغ خارج الدفاتر لحظةً)
// وسقف عمر للكاش المحلي (أسعار أقدم من ٤٨ ساعة ⇒ قراءة فقط بلا بيع).

import { getLastSyncAt } from "./catalogSync";
import { D } from "../money";
import { decryptJson, encryptJson, isEncryptedEnvelope, isLegacyZeroIvEnvelope } from "./crypto";
import { getMeta, offlineDb, setMeta, type OfflineOutboxItem, type OfflineOutboxKind } from "./db";
import { getOfflineProfile } from "./pinLock";
import { LEGACY_OUTBOX_REVIEW_MESSAGE, partitionOutboxByIdentity } from "./outboxIdentity";

export const OFFLINE_QUEUE_CAP_IQD = 5_000_000;
export const OFFLINE_CACHE_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
const SERVER_ERROR_MAX_ATTEMPTS = 5;
const SENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const SENDING_LEASE_MS = 5 * 60 * 1000;

export interface OfflineSaleLine {
  variantId: number;
  productUnitId: number;
  quantity: string;
  unitPriceOverride: string;
  discountPercent?: string;
  discountAmount?: string;
}

export interface OfflineSalePayload {
  branchId: number;
  shiftId: number;
  customerId?: number;
  priceTier?: "RETAIL" | "WHOLESALE" | "GOVERNMENT";
  lines: OfflineSaleLine[];
  /** خصم على رأس الفاتورة (مبلغ، عملة الفرع). الخادم يُطبّقه بعد مجموع الأسطر وقبل الضريبة. */
  invoiceDiscount?: string;
  payment: { amount: string; method: "CASH" };
  clientRequestId: string;
  cashRoundIQD?: boolean;
  notes?: string;
}

/** خدمات الطباعة: سعرٌ يدويّ لكل سطر (طبيعة الشاشة)، بلا خصم سطر. */
export interface OfflinePrintSalePayload {
  branchId: number;
  shiftId: number;
  customerId?: number;
  contactName?: string;
  contactPhone?: string;
  priceTier?: "RETAIL" | "WHOLESALE" | "GOVERNMENT";
  lines: Array<{ variantId: number; productUnitId: number; quantity: string; unitPriceOverride: string }>;
  payment: { amount: string; method: "CASH" };
  clientRequestId: string;
  cashRoundIQD?: boolean;
  notes?: string;
}

/** سلّة الاستقبال: بضاعةٌ جاهزة و/أو خدمات طباعة في معاملةٍ واحدة. **بلا أوامر شغل** —
 *  ترقيمها وإسنادها وصورها خادميّة، فلا تُلتقَط أصلاً (الشاشة ترفض قبل الوصول إلى هنا). */
export interface OfflineReceptionPayload {
  branchId: number;
  shiftId: number;
  customerId?: number;
  contactName?: string;
  contactPhone?: string;
  priceTier?: "RETAIL" | "WHOLESALE" | "GOVERNMENT";
  paymentMethod: "CASH";
  paidAmount: string;
  regularSale?: { lines: OfflineSaleLine[]; amount: string; invoiceDiscount?: string } | null;
  printSale?: { lines: Array<{ variantId: number; productUnitId: number; quantity: string; unitPriceOverride: string }>; amount: string } | null;
  clientRequestId: string;
}

/**
 * مرتجعُ بيعٍ نقديّ التُقط دون اتصال (١/٩/٢٦). **الحمولةُ الوحيدة التي تُخرج نقداً** من
 * الطابور، ولذلك تحمل سبباً إلزامياً ومصيرَ البضاعة صريحاً — لا يقع ديناران بلا مستند.
 * ⚠️ سقفُ الاسترداد لا يُقيَّم على الجهاز (يحتاج تاريخ قبضِ الفاتورة كاملاً)؛ يُقيَّمه الخادم
 * عند الترحيل، والرفضُ يُعلَّق في طابور الاسترداد بقناة RETURN لمراجعة المدير.
 */
export interface OfflineReturnPayload {
  branchId: number;
  shiftId: number | null;
  invoiceId: number;
  lines: Array<{ invoiceItemId: number; baseQuantity: number }>;
  refund: { amount: string; method: "CASH"; shiftId?: number | null };
  restock: boolean;
  reason: string;
  clientRequestId: string;
}

export type OfflinePayload =
  | OfflineSalePayload
  | OfflinePrintSalePayload
  | OfflineReceptionPayload
  | OfflineReturnPayload;

// ── البيع الأوفلايني: **مفعَّل تلقائياً** على كل جهاز (قرار مالك ١٦/٨/٢٦) ──
//
// كان افتراضه معطَّلاً ويلزمه تفعيلٌ يدويّ لكل جهاز (بوّابة تجربة ش٥). النتيجة العملية:
// كاشيرٌ ينقطع عنه الإنترنت فلا يستطيع البيع أصلاً — لأنّ أحداً لم يفتح إعدادات جهازه سلفاً.
// وهذا يناقض غرض المنظومة: الالتقاط يجب أن يشتغل **لحظة الانقطاع بلا تدخّل بشريّ**.
//
// الآن: مفعَّلٌ ما لم يُعطَّل صراحةً ("0") — أي المفتاح صار **استثناءً** لا شرطاً، ويبقى
// متاحاً لاستبعاد جهازٍ بعينه (حاسوب إداريّ مثلاً).
//
// ⚠️ ما لم يتغيّر — وهي حرّاس السلامة الحقيقية، تبقى نافذةً كلّها:
//   • الأسعار المحلية أحدث من ٤٨ ساعة (assertCanCapture) وإلّا لا التقاط.
//   • سقف قيمة الطابور.
//   • نقديّ كامل فقط: لا آجل ولا بطاقة ولا بيع رقميّ.
//   • الالتقاط لا يحدث إلّا عند فشل النقل فعلياً — لا «وضع أوفلاين» اختياريّ.
// ويبوّب هذا العَلَم **الكتابة** وحدها؛ القراءة (تصفّح/مسح/سعر) كانت وتبقى دائمة.

const OFFLINE_SALE_FLAG_KEY = "offlineSaleEnabled";

export async function isOfflineSaleEnabled(): Promise<boolean> {
  // الغياب = مفعَّل. لا يُعطَّل إلّا بقيمة "0" صريحة كتبها مديرٌ من إعدادات الجهاز.
  return (await getMeta(OFFLINE_SALE_FLAG_KEY)) !== "0";
}

export async function setOfflineSaleEnabled(enabled: boolean): Promise<void> {
  await setMeta(OFFLINE_SALE_FLAG_KEY, enabled ? "1" : "0");
  notifyOutboxChanged();
}

// ── معرّف الجهاز + الترقيم المؤقّت ──────────────────────────────────────────

const DEVICE_CODE_KEY = "deviceCode";
const RECEIPT_SEQ_KEY = "offlineReceiptSeq";

export async function getDeviceCode(): Promise<string> {
  const existing = await getMeta(DEVICE_CODE_KEY);
  if (existing) return existing;
  const bytes = new Uint8Array(2);
  globalThis.crypto?.getRandomValues?.(bytes);
  const code = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  await setMeta(DEVICE_CODE_KEY, code);
  return code;
}

/** يخصّص الرقم المؤقّت التالي `OFF-{فرع}-{جهاز}-{تسلسل}` — يُطبع على إيصال الزبون ويُخزَّن
 *  على الفاتورة عند الترحيل فيبقى قابلاً للبحث بورقته. */
export async function allocateOfflineReceiptNumber(branchId: number): Promise<string> {
  const device = await getDeviceCode();
  const seq = Number((await getMeta(RECEIPT_SEQ_KEY)) ?? "0") + 1;
  await setMeta(RECEIPT_SEQ_KEY, String(seq));
  return `OFF-${branchId}-${device}-${seq}`;
}

// ── إشعارات تغيّر الطابور (لواجهة الشارة/الدرج) ─────────────────────────────

type OutboxListener = () => void;
const listeners = new Set<OutboxListener>();
export function subscribeOutbox(cb: OutboxListener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
function notifyOutboxChanged() {
  listeners.forEach((cb) => cb());
}

// ── صمّاما الأمان ────────────────────────────────────────────────────────────

function validatedTotal(value: string | number, allowZero = false) {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error("Invalid offline total");
  }
  const format = allowZero ? /^\d+(?:\.\d+)?$/ : /^\d+(?:\.\d{1,2})?$/;
  if (typeof value === "string" && !format.test(value)) {
    throw new Error("Invalid offline total");
  }
  const total = D(value);
  if (!total.isFinite() || total.lt(0) || (!allowZero && total.isZero())) {
    throw new Error("Invalid offline total");
  }
  if (!allowZero && total.decimalPlaces() > 2) throw new Error("Invalid offline total precision");
  return total;
}

async function unresolvedIncomingTotal() {
  const items = await offlineDb.outbox
    .where("status")
    .anyOf("QUEUED", "SENDING", "PARKED")
    .toArray();
  // RETURN never releases sale capacity; a missing legacy kind means SALE.
  return items.reduce(
    (sum, item) => item.kind === "RETURN"
      ? sum
      // Older capture allowed zero (discounts/cash rounding). Preserve it without blocking sales.
      : sum.plus(validatedTotal(item.total, true)),
    D(0),
  );
}

export async function queuedTotalIQD(): Promise<number> {
  // Preserve the display API; admission keeps Decimal throughout. Corrupt exposure fails closed.
  try {
    return (await unresolvedIncomingTotal()).toNumber();
  } catch {
    return Infinity;
  }
}

function isCatalogFresh(lastSync: string | null): boolean {
  if (!lastSync) return false;
  const age = Date.now() - new Date(lastSync).getTime();
  return Number.isFinite(age) && age >= 0 && age <= OFFLINE_CACHE_MAX_AGE_MS;
}

/** بوّابة قبول بيع أوفلايني جديد — ترفض بسبب صريح يفهمه الكاشير. */
export async function assertCanCapture(saleTotalIQD: number, kind: OfflineOutboxKind = "SALE"): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const total = validatedTotal(saleTotalIQD);
    const lastSync = await getLastSyncAt();
    if (!isCatalogFresh(lastSync)) {
      return {
        ok: false,
        reason: "الأسعار المحلية أقدم من ٤٨ ساعة — البيع الأوفلايني متوقف حتى مزامنةٍ ناجحة (القراءة والاستعلام متاحان)",
      };
    }
    const queued = kind === "RETURN" ? D(0) : await unresolvedIncomingTotal();
    if (kind !== "RETURN" && queued.plus(total).gt(OFFLINE_QUEUE_CAP_IQD)) {
      return {
        ok: false,
        reason: `بلغ طابور المزامنة سقفه (${OFFLINE_QUEUE_CAP_IQD.toLocaleString("en")} د.ع) — أعد الاتصال لتفريغه قبل قبول مبيعات جديدة`,
      };
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      reason: "تعذّر التحقق من قيمة طابور المزامنة — تحقق من المبلغ والتخزين المحلي قبل قبول مبيعات جديدة",
    };
  }
}

// ── الالتقاط ────────────────────────────────────────────────────────────────

export async function enqueueOfflineItem(args: {
  kind: OfflineOutboxKind;
  payload: OfflinePayload;
  offlineReceiptNumber: string;
  total: string;
  capturedByUserId?: number;
}): Promise<boolean> {
  try {
    const total = validatedTotal(args.total);
    const profile = args.capturedByUserId ? null : await getOfflineProfile();
    const capturedByUserId = Number(args.capturedByUserId ?? profile?.userId ?? 0);
    if (!Number.isInteger(capturedByUserId) || capturedByUserId <= 0) return false;
    const item: OfflineOutboxItem = {
      clientRequestId: args.payload.clientRequestId,
      kind: args.kind,
      // ش٥: الحمولة (تفاصيل البيع/العميل/المبالغ) مشفَّرة AES-GCM بمفتاح الجهاز غير القابل
      // للاستخراج — ما يبقى صريحاً على العنصر هو ما تحتاجه الواجهة والصمّامات فقط.
      payload: await encryptJson(args.payload),
      offlineReceiptNumber: args.offlineReceiptNumber,
      capturedAt: new Date().toISOString(),
      capturedByUserId,
      shiftId: args.payload.shiftId,
      branchId: args.payload.branchId,
      status: "QUEUED",
      attempts: 0,
      lastError: null,
      total: args.total,
    };
    // WebCrypto must finish before opening IndexedDB's transaction (otherwise it auto-commits).
    const lastSync = args.kind === "RETURN" ? null : await getLastSyncAt();
    const saved = await offlineDb.transaction("rw", offlineDb.outbox, async () => {
      // An existing command owns its key forever, including SENT/PARKED and active leases.
      if (await offlineDb.outbox.get(item.clientRequestId)) return false;
      if (args.kind !== "RETURN") {
        if (!isCatalogFresh(lastSync)) return false;
        if ((await unresolvedIncomingTotal()).plus(total).gt(OFFLINE_QUEUE_CAP_IQD)) return false;
      }
      await offlineDb.outbox.add(item);
      return true;
    });
    if (!saved) return false;
    notifyOutboxChanged();
    return true;
  } catch {
    // حصة ممتلئة/وضع خاص — الواجهة تمنع تسليم البضاعة بدل الانفجار.
    return false;
  }
}

/** التقاطُ مرتجعٍ نقديّ (kind = RETURN) — النقدُ خرج فعلاً، فالالتقاط أصدق من الرفض. */
export async function enqueueOfflineReturn(args: {
  payload: OfflineReturnPayload;
  offlineReceiptNumber: string;
  total: string;
  capturedByUserId?: number;
}): Promise<boolean> {
  return enqueueOfflineItem({ kind: "RETURN", ...args });
}

/** غلاف توافقٍ رجعيّ لكاشير التجزئة (kind = SALE) — المستدعي الأقدم يبقى بلا تعديل. */
export async function enqueueOfflineSale(args: {
  payload: OfflineSalePayload;
  offlineReceiptNumber: string;
  total: string;
  capturedByUserId?: number;
}): Promise<boolean> {
  return enqueueOfflineItem({ kind: "SALE", ...args });
}

/** يقرأ حمولة العنصر: مغلّفة مشفَّرة (ش٥) تُفكّ؛ وعناصر ما قبل التشفير تُقرأ كما هي (توافق رجعي). */
export async function readItemPayload(item: OfflineOutboxItem): Promise<OfflinePayload> {
  if (isEncryptedEnvelope(item.payload)) {
    const wasLegacyZeroIv = isLegacyZeroIvEnvelope(item.payload);
    const decoded = await decryptJson<OfflinePayload>(item.payload);
    if (wasLegacyZeroIv) {
      try {
        const migrated = await encryptJson(decoded);
        if (!isLegacyZeroIvEnvelope(migrated)) {
          await offlineDb.outbox.update(item.clientRequestId, { payload: migrated });
          item.payload = migrated;
        }
      } catch {
        // نبقي الحمولة المفكوكة قابلةً للإعادة حتى لو تعذّر تحديث السجلّ لحظياً.
      }
    }
    return decoded;
  }
  return item.payload as OfflinePayload;
}

// ── محرك التفريغ ────────────────────────────────────────────────────────────

export interface ReplayResult {
  invoiceId: number;
  invoiceNumber: string;
  idempotentReplay?: boolean;
}
export interface ReplayArgs {
  payload: OfflinePayload;
  capturedAt: string;
  offlineReceiptNumber: string;
  deviceId: string;
}
export type ReplaySaleApi = (args: ReplayArgs) => Promise<ReplayResult>;

/**
 * خريطة الترحيل بحسب نوع الكاشير. المحرّك لا يعرف شيئاً عن العقود الخادمية — يختار المسار
 * من `item.kind` فقط. غياب مسارٍ لنوعٍ ما ⇒ العنصر يُعلَّق برسالةٍ صريحة بدل محاولةٍ خاطئة
 * (مثلاً: شاشةٌ لم تُمرِّر إلا مسارها فتلقّى الطابور عنصراً من نوعٍ آخر).
 */
export type ReplayApiMap = Partial<Record<OfflineOutboxKind, ReplaySaleApi>>;

/** يقبل المحرّك دالةً واحدة (توافق رجعيّ = كلّها SALE) أو خريطةً كاملة. */
function toApiMap(api: ReplaySaleApi | ReplayApiMap): ReplayApiMap {
  return typeof api === "function" ? { SALE: api } : api;
}

interface FlushState {
  flushing: boolean;
  backoffUntil: number;
  backoffMs: number;
  needsLogin: boolean;
}
const flushState: FlushState = { flushing: false, backoffUntil: 0, backoffMs: BACKOFF_MIN_MS, needsLogin: false };

export function outboxNeedsLogin(): boolean {
  return flushState.needsLogin;
}

function classifyTrpcError(err: unknown): { kind: "transport" | "unauthorized" | "server" | "business"; message: string } {
  const anyErr = err as { data?: { code?: string }; message?: string };
  const code = anyErr?.data?.code;
  const message = anyErr?.message || "خطأ غير معروف";
  if (!code) return { kind: "transport", message };
  if (code === "UNAUTHORIZED") return { kind: "unauthorized", message };
  if (code === "INTERNAL_SERVER_ERROR" || code === "TIMEOUT") return { kind: "server", message };
  return { kind: "business", message };
}

async function cleanupSent(): Promise<void> {
  try {
    const cutoff = Date.now() - SENT_RETENTION_MS;
    const sent = await offlineDb.outbox.where("status").equals("SENT").toArray();
    const stale = sent
      .filter((i: OfflineOutboxItem) => new Date(i.capturedAt).getTime() < cutoff)
      .map((i: OfflineOutboxItem) => i.clientRequestId);
    if (stale.length) await offlineDb.outbox.bulkDelete(stale);
  } catch {
    // تنظيف تجميلي — فشله لا يهم.
  }
}

function leaseExpired(item: OfflineOutboxItem): boolean {
  return (
    item.status === "QUEUED" ||
    !Number.isFinite(item.sendingLeaseUntil) ||
    !item.sendingLeaseUntil ||
    item.sendingLeaseUntil <= Date.now()
  );
}

async function claimReplay(
  item: OfflineOutboxItem,
  parked = false,
): Promise<OfflineOutboxItem | null> {
  return offlineDb.transaction("rw", offlineDb.outbox, async () => {
    const current = await offlineDb.outbox.get(item.clientRequestId);
    if (!current || current.capturedByUserId !== item.capturedByUserId)
      return null;
    if (
      parked
        ? current.status !== "PARKED"
        : !["QUEUED", "SENDING"].includes(current.status) ||
          !leaseExpired(current)
    )
      return null;
    const claimed = {
      ...current,
      status: "SENDING" as const,
      sendingToken: crypto.randomUUID(),
      sendingLeaseUntil: Date.now() + SENDING_LEASE_MS,
    };
    await offlineDb.outbox.update(current.clientRequestId, claimed);
    return claimed;
  });
}

/** A late response from an expired tab cannot overwrite a newer attempt. */
async function updateClaimed(
  item: OfflineOutboxItem,
  patch: Partial<OfflineOutboxItem>,
): Promise<void> {
  await offlineDb.transaction("rw", offlineDb.outbox, async () => {
    const current = await offlineDb.outbox.get(item.clientRequestId);
    if (
      current?.status !== "SENDING" ||
      current.sendingToken !== item.sendingToken
    )
      return;
    await offlineDb.outbox.update(item.clientRequestId, {
      ...patch,
      ...(patch.status && patch.status !== "SENDING"
        ? { sendingToken: null, sendingLeaseUntil: null }
        : {}),
    });
  });
}

/** تفريغ الطابور: FIFO، طلب واحد بالطيران. يُستدعى من محفّزات useOutbox أو زرّ «مزامنة الآن». */
export async function flushOutbox(
  api: ReplaySaleApi | ReplayApiMap,
  opts: { currentUserId: number; force?: boolean },
): Promise<void> {
  const apis = toApiMap(api);
  if (!Number.isInteger(opts.currentUserId) || opts.currentUserId <= 0) return;
  if (flushState.flushing) return;
  if (!opts?.force && Date.now() < flushState.backoffUntil) return;
  flushState.flushing = true;
  notifyOutboxChanged();
  try {
    await cleanupSent();
    const deviceId = await getDeviceCode();
    // عناصرٌ تخطّيناها لغياب مسار نوعها — تُستثنى من الاختيار كي لا تدور الحلقة عليها أبداً.
    let skippedKinds = 0;
    for (;;) {
      const queued = (
        await offlineDb.outbox
          .where("status")
          .anyOf("QUEUED", "SENDING")
          .sortBy("capturedAt")
      ).filter(leaseExpired);
      const { replayable, legacy } = partitionOutboxByIdentity(
        queued,
        opts.currentUserId,
      );
      if (legacy.length > 0) {
        await Promise.all(
          legacy.map((item) =>
            offlineDb.outbox.update(item.clientRequestId, {
              status: "PARKED",
              capturedByUserId: null,
              lastError: LEGACY_OUTBOX_REVIEW_MESSAGE,
            }),
          ),
        );
        notifyOutboxChanged();
      }
      const candidate = replayable[skippedKinds];
      if (!candidate) break;
      const next = await claimReplay(candidate);
      if (!next) continue;
      notifyOutboxChanged();
      // فشل فكّ التشفير (مفتاح جهاز مُتلَف/مُبدَّل) ليس خطأ شبكة — تعليق فوري لا backoff أبدي.
      // اختيار المسار قبل فكّ التشفير: عنصرٌ من نوعٍ لا تملك هذه الشاشة مسارَه لا يُستهلك
      // ولا يُعلَّق — يُترَك في الطابور لتفريغه شاشتُه (أو الشارة العامّة) بلا فقدٍ للنقد.
      const kindApi = apis[next.kind ?? "SALE"];
      if (!kindApi) {
        await updateClaimed(next, { status: "QUEUED" });
        skippedKinds += 1;
        continue;
      }
      let payload: OfflinePayload;
      try {
        payload = await readItemPayload(next);
      } catch {
        await updateClaimed(next, {
          status: "PARKED",
          lastError:
            "تعذّر فكّ تشفير العنصر محلياً — راجع المدير (مفتاح الجهاز تغيّر؟)",
        });
        notifyOutboxChanged();
        continue;
      }
      const heartbeat = setInterval(() => {
        void updateClaimed(next, {
          sendingLeaseUntil: Date.now() + SENDING_LEASE_MS,
        }).catch(() => {});
      }, SENDING_LEASE_MS / 3);
      try {
        const res = await kindApi({
          payload,
          capturedAt: next.capturedAt,
          offlineReceiptNumber: next.offlineReceiptNumber,
          deviceId,
        });
        await updateClaimed(next, {
          status: "SENT",
          lastError: null,
          // نخزّن الرقم الرسمي على العنصر — درج المزامنة يعرض ربط OFF ↔ INV.
          ...(res.invoiceNumber
            ? ({
                resultInvoiceNumber: res.invoiceNumber,
              } as Partial<OfflineOutboxItem>)
            : {}),
        });
        flushState.backoffMs = BACKOFF_MIN_MS;
        flushState.needsLogin = false;
        notifyOutboxChanged();
      } catch (err) {
        const cls = classifyTrpcError(err);
        if (cls.kind === "transport") {
          await updateClaimed(next, { status: "QUEUED", lastError: null });
          flushState.backoffUntil = Date.now() + flushState.backoffMs;
          flushState.backoffMs = Math.min(
            flushState.backoffMs * 2,
            BACKOFF_MAX_MS,
          );
          break;
        }
        if (cls.kind === "unauthorized") {
          await updateClaimed(next, { status: "QUEUED", lastError: null });
          flushState.needsLogin = true;
          break;
        }
        if (cls.kind === "server") {
          const attempts = next.attempts + 1;
          if (attempts >= SERVER_ERROR_MAX_ATTEMPTS) {
            await updateClaimed(next, {
              status: "PARKED",
              attempts,
              lastError: cls.message,
            });
          } else {
            await updateClaimed(next, {
              status: "QUEUED",
              attempts,
              lastError: cls.message,
            });
            flushState.backoffUntil = Date.now() + flushState.backoffMs;
            flushState.backoffMs = Math.min(
              flushState.backoffMs * 2,
              BACKOFF_MAX_MS,
            );
            notifyOutboxChanged();
            break;
          }
        } else {
          // رفض أعمال: يُعلَّق هذا العنصر ويُكمل التفريغ — النقود التالية لا تنتظر قرار مدير.
          await updateClaimed(next, {
            status: "PARKED",
            attempts: next.attempts + 1,
            lastError: cls.message,
          });
        }
        notifyOutboxChanged();
      } finally {
        clearInterval(heartbeat);
      }
    }
  } finally {
    flushState.flushing = false;
    notifyOutboxChanged();
  }
}

// ── قراءة ملخّص/عناصر للواجهة ───────────────────────────────────────────────

export interface OutboxSummary {
  queued: number;
  parked: number;
  sentRecent: number;
  queuedTotal: number;
  flushing: boolean;
  needsLogin: boolean;
}

export async function readOutboxSummary(): Promise<OutboxSummary> {
  try {
    const [queued, sending, parked, sent] = await Promise.all([
      offlineDb.outbox.where("status").equals("QUEUED").count(),
      offlineDb.outbox.where("status").equals("SENDING").count(),
      offlineDb.outbox.where("status").equals("PARKED").count(),
      offlineDb.outbox.where("status").equals("SENT").count(),
    ]);
    return {
      queued: queued + sending,
      parked,
      sentRecent: sent,
      queuedTotal: await queuedTotalIQD(),
      flushing: flushState.flushing,
      needsLogin: flushState.needsLogin,
    };
  } catch {
    return { queued: 0, parked: 0, sentRecent: 0, queuedTotal: 0, flushing: false, needsLogin: false };
  }
}

export async function readShiftOutboxSummary(shiftId?: number | null): Promise<{ queued: number; queuedTotal: number }> {
  try {
    const items = await offlineDb.outbox.where("status").anyOf("QUEUED", "SENDING").toArray();
    const shiftItems = shiftId != null ? items.filter((i) => (i.payload as { shiftId?: number }).shiftId === shiftId) : items;
    return {
      queued: shiftItems.length,
      queuedTotal: shiftItems.reduce((sum, i) => sum + Number(i.total || 0), 0),
    };
  } catch {
    return { queued: 0, queuedTotal: 0 };
  }
}

export async function listOutboxItems(): Promise<OfflineOutboxItem[]> {
  try {
    const items = await offlineDb.outbox.toArray();
    return items.sort((a: OfflineOutboxItem, b: OfflineOutboxItem) => b.capturedAt.localeCompare(a.capturedAt));
  } catch {
    return [];
  }
}

/** إعادة محاولة عنصر معلَّق يدوياً (زر في درج المزامنة) — يعيده للطابور ويفرّغ فوراً. */
export async function requeueParkedItem(
  clientRequestId: string,
): Promise<void> {
  await offlineDb.transaction("rw", offlineDb.outbox, async () => {
    const current = await offlineDb.outbox.get(clientRequestId);
    if (current?.status !== "PARKED") return;
    await offlineDb.outbox.update(clientRequestId, {
      status: "QUEUED",
      lastError: null,
      sendingToken: null,
      sendingLeaseUntil: null,
    });
  });
  notifyOutboxChanged();
}

/**
 * ش٤ — ترحيل عنصرٍ معلَّق واحد بسلطة مدير (تحت التكلفة FORBIDDEN): الشارة تبني نداءً
 * يحمل managerApproval ويُتحقَّق خادمياً (rate-limit + توقيت ثابت + SOD + تدقيق).
 * لا يمرّ بمحرّك FIFO — عنصر واحد بقرار بشري صريح.
 */
export async function replayParkedWithApproval(
  clientRequestId: string,
  api: ReplaySaleApi | ReplayApiMap,
): Promise<{ ok: boolean; error?: string }> {
  const parked = await offlineDb.outbox.get(clientRequestId);
  if (!parked || parked.status !== "PARKED")
    return { ok: false, error: "العنصر لم يعد معلَّقاً" };
  // نفس اختيار المسار بحسب النوع كما في محرّك التفريغ — لا يُرحَّل عنصرُ استقبالٍ عبر مسار
  // التجزئة لأن الشاشة مرّرت دالةً واحدة.
  const kindApi = toApiMap(api)[parked.kind ?? "SALE"];
  if (!kindApi) return { ok: false, error: "هذا النوع لا يُرحَّل من هذه الشاشة — افتح شاشته أو شارة المزامنة العامّة" };
  const item = await claimReplay(parked, true);
  if (!item) return { ok: false, error: "العنصر قيد المعالجة في نافذة أخرى" };
  notifyOutboxChanged();
  const heartbeat = setInterval(() => {
    void updateClaimed(item, {
      sendingLeaseUntil: Date.now() + SENDING_LEASE_MS,
    }).catch(() => {});
  }, SENDING_LEASE_MS / 3);
  try {
    const deviceId = await getDeviceCode();
    const res = await kindApi({
      payload: await readItemPayload(item),
      capturedAt: item.capturedAt,
      offlineReceiptNumber: item.offlineReceiptNumber,
      deviceId,
    });
    await updateClaimed(item, {
      status: "SENT",
      lastError: null,
      ...(res.invoiceNumber
        ? ({
            resultInvoiceNumber: res.invoiceNumber,
          } as Partial<OfflineOutboxItem>)
        : {}),
    });
    notifyOutboxChanged();
    return { ok: true };
  } catch (err) {
    const cls = classifyTrpcError(err);
    await updateClaimed(item, {
      status: "PARKED",
      attempts: item.attempts + 1,
      lastError: cls.message,
    });
    notifyOutboxChanged();
    return { ok: false, error: cls.message };
  } finally {
    clearInterval(heartbeat);
  }
}
