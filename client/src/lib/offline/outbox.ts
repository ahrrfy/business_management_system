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
import { getMeta, offlineDb, setMeta, type OfflineOutboxItem } from "./db";

export const OFFLINE_QUEUE_CAP_IQD = 5_000_000;
export const OFFLINE_CACHE_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
const SERVER_ERROR_MAX_ATTEMPTS = 5;
const SENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

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
  payment: { amount: string; method: "CASH" };
  clientRequestId: string;
  cashRoundIQD?: boolean;
  notes?: string;
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

export async function queuedTotalIQD(): Promise<number> {
  const items = await offlineDb.outbox.where("status").anyOf("QUEUED", "SENDING").toArray();
  return items.reduce((sum, i) => sum + Number(i.total || 0), 0);
}

/** بوّابة قبول بيع أوفلايني جديد — ترفض بسبب صريح يفهمه الكاشير. */
export async function assertCanCapture(saleTotalIQD: number): Promise<{ ok: true } | { ok: false; reason: string }> {
  const lastSync = await getLastSyncAt();
  if (!lastSync || Date.now() - new Date(lastSync).getTime() > OFFLINE_CACHE_MAX_AGE_MS) {
    return {
      ok: false,
      reason: "الأسعار المحلية أقدم من ٤٨ ساعة — البيع الأوفلايني متوقف حتى مزامنةٍ ناجحة (القراءة والاستعلام متاحان)",
    };
  }
  const queued = await queuedTotalIQD();
  if (queued + saleTotalIQD > OFFLINE_QUEUE_CAP_IQD) {
    return {
      ok: false,
      reason: `بلغ طابور المزامنة سقفه (${OFFLINE_QUEUE_CAP_IQD.toLocaleString("en")} د.ع) — أعد الاتصال لتفريغه قبل قبول مبيعات جديدة`,
    };
  }
  return { ok: true };
}

// ── الالتقاط ────────────────────────────────────────────────────────────────

export async function enqueueOfflineSale(args: {
  payload: OfflineSalePayload;
  offlineReceiptNumber: string;
  total: string;
}): Promise<boolean> {
  try {
    const item: OfflineOutboxItem = {
      clientRequestId: args.payload.clientRequestId,
      kind: "SALE",
      payload: args.payload,
      offlineReceiptNumber: args.offlineReceiptNumber,
      capturedAt: new Date().toISOString(),
      shiftId: args.payload.shiftId,
      branchId: args.payload.branchId,
      status: "QUEUED",
      attempts: 0,
      lastError: null,
      total: args.total,
    };
    await offlineDb.outbox.put(item);
    notifyOutboxChanged();
    return true;
  } catch {
    // حصة ممتلئة/وضع خاص — الواجهة تمنع تسليم البضاعة بدل الانفجار.
    return false;
  }
}

// ── محرك التفريغ ────────────────────────────────────────────────────────────

export interface ReplayResult {
  invoiceId: number;
  invoiceNumber: string;
  idempotentReplay?: boolean;
}
export type ReplaySaleApi = (args: {
  payload: OfflineSalePayload;
  capturedAt: string;
  offlineReceiptNumber: string;
  deviceId: string;
}) => Promise<ReplayResult>;

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
    const stale = sent.filter((i) => new Date(i.capturedAt).getTime() < cutoff).map((i) => i.clientRequestId);
    if (stale.length) await offlineDb.outbox.bulkDelete(stale);
  } catch {
    // تنظيف تجميلي — فشله لا يهم.
  }
}

/** تفريغ الطابور: FIFO، طلب واحد بالطيران. يُستدعى من محفّزات useOutbox أو زرّ «مزامنة الآن». */
export async function flushOutbox(api: ReplaySaleApi, opts?: { force?: boolean }): Promise<void> {
  if (flushState.flushing) return;
  if (!opts?.force && Date.now() < flushState.backoffUntil) return;
  flushState.flushing = true;
  notifyOutboxChanged();
  try {
    await cleanupSent();
    const deviceId = await getDeviceCode();
    for (;;) {
      const next = (await offlineDb.outbox.where("status").equals("QUEUED").sortBy("capturedAt"))[0];
      if (!next) break;
      await offlineDb.outbox.update(next.clientRequestId, { status: "SENDING" });
      notifyOutboxChanged();
      try {
        const res = await api({
          payload: next.payload as OfflineSalePayload,
          capturedAt: next.capturedAt,
          offlineReceiptNumber: next.offlineReceiptNumber,
          deviceId,
        });
        await offlineDb.outbox.update(next.clientRequestId, {
          status: "SENT",
          lastError: null,
          // نخزّن الرقم الرسمي على العنصر — درج المزامنة يعرض ربط OFF ↔ INV.
          ...(res.invoiceNumber ? { resultInvoiceNumber: res.invoiceNumber } as Partial<OfflineOutboxItem> : {}),
        });
        flushState.backoffMs = BACKOFF_MIN_MS;
        flushState.needsLogin = false;
        notifyOutboxChanged();
      } catch (err) {
        const cls = classifyTrpcError(err);
        if (cls.kind === "transport") {
          await offlineDb.outbox.update(next.clientRequestId, { status: "QUEUED", lastError: null });
          flushState.backoffUntil = Date.now() + flushState.backoffMs;
          flushState.backoffMs = Math.min(flushState.backoffMs * 2, BACKOFF_MAX_MS);
          break;
        }
        if (cls.kind === "unauthorized") {
          await offlineDb.outbox.update(next.clientRequestId, { status: "QUEUED", lastError: null });
          flushState.needsLogin = true;
          break;
        }
        if (cls.kind === "server") {
          const attempts = next.attempts + 1;
          if (attempts >= SERVER_ERROR_MAX_ATTEMPTS) {
            await offlineDb.outbox.update(next.clientRequestId, { status: "PARKED", attempts, lastError: cls.message });
          } else {
            await offlineDb.outbox.update(next.clientRequestId, { status: "QUEUED", attempts, lastError: cls.message });
            flushState.backoffUntil = Date.now() + flushState.backoffMs;
            flushState.backoffMs = Math.min(flushState.backoffMs * 2, BACKOFF_MAX_MS);
            notifyOutboxChanged();
            break;
          }
        } else {
          // رفض أعمال: يُعلَّق هذا العنصر ويُكمل التفريغ — النقود التالية لا تنتظر قرار مدير.
          await offlineDb.outbox.update(next.clientRequestId, {
            status: "PARKED",
            attempts: next.attempts + 1,
            lastError: cls.message,
          });
        }
        notifyOutboxChanged();
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

export async function listOutboxItems(): Promise<OfflineOutboxItem[]> {
  try {
    const items = await offlineDb.outbox.toArray();
    return items.sort((a: OfflineOutboxItem, b: OfflineOutboxItem) => b.capturedAt.localeCompare(a.capturedAt));
  } catch {
    return [];
  }
}

/** إعادة محاولة عنصر معلَّق يدوياً (زر في درج المزامنة) — يعيده للطابور ويفرّغ فوراً. */
export async function requeueParkedItem(clientRequestId: string): Promise<void> {
  await offlineDb.outbox.update(clientRequestId, { status: "QUEUED", lastError: null });
  notifyOutboxChanged();
}

/**
 * ش٤ — ترحيل عنصرٍ معلَّق واحد بسلطة مدير (تحت التكلفة FORBIDDEN): الشارة تبني نداءً
 * يحمل managerApproval ويُتحقَّق خادمياً (rate-limit + توقيت ثابت + SOD + تدقيق).
 * لا يمرّ بمحرّك FIFO — عنصر واحد بقرار بشري صريح.
 */
export async function replayParkedWithApproval(
  clientRequestId: string,
  api: ReplaySaleApi,
): Promise<{ ok: boolean; error?: string }> {
  const item = await offlineDb.outbox.get(clientRequestId);
  if (!item || item.status !== "PARKED") return { ok: false, error: "العنصر لم يعد معلَّقاً" };
  await offlineDb.outbox.update(clientRequestId, { status: "SENDING" });
  notifyOutboxChanged();
  try {
    const deviceId = await getDeviceCode();
    const res = await api({
      payload: item.payload as OfflineSalePayload,
      capturedAt: item.capturedAt,
      offlineReceiptNumber: item.offlineReceiptNumber,
      deviceId,
    });
    await offlineDb.outbox.update(clientRequestId, {
      status: "SENT",
      lastError: null,
      ...(res.invoiceNumber ? ({ resultInvoiceNumber: res.invoiceNumber } as Partial<OfflineOutboxItem>) : {}),
    });
    notifyOutboxChanged();
    return { ok: true };
  } catch (err) {
    const cls = classifyTrpcError(err);
    await offlineDb.outbox.update(clientRequestId, {
      status: "PARKED",
      attempts: item.attempts + 1,
      lastError: cls.message,
    });
    notifyOutboxChanged();
    return { ok: false, error: cls.message };
  }
}
