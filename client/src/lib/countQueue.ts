/**
 * countQueue — طابور أوفلاين لِعدّات بوابة الجرد العامة (CountPortal).
 *
 * المخزن: localStorage بمفتاح `countq_<sessionCode>` — يصمد على إغلاق المتصفح
 * وانقطاع الكهرباء (شبكة المخزن الخلفي ضعيفة). كل عنصر يحمل `clientRequestId`
 * ثابتاً يولَّد مرة واحدة لحظة العدّ، فإعادة الإرسال idempotent على الخادم
 * (قيد UNIQUE(sessionId, clientRequestId) في stocktakeCounts) — التكرار آمن دائماً.
 *
 * كل الدوال آمنة الفشل (try/catch حول localStorage): وضع التصفح الخاص أو امتلاء
 * الحصة لا يرمي أبداً — `enqueue` تُرجع false فتتعامل الواجهة بأدب.
 */

export interface QueuedCount {
  /** معرّف idempotency — يولَّد عند العدّ ويثبت عبر كل محاولات المزامنة. */
  clientRequestId: string;
  variantId: number;
  /** الكمية بالوحدة الأساس (عدد صحيح ≥ 0). */
  qty: number;
  /** تفصيل الوحدات JSON مثل {"كرتون":2,"قطعة":5} — للتدقيق (≤ 500 حرف). */
  unitBreakdown?: string;
  /** وقت الحفظ المحلي (ISO). */
  queuedAt: string;
}

const keyFor = (sessionCode: string) => `countq_${sessionCode}`;

function isQueuedCount(v: unknown): v is QueuedCount {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.clientRequestId === "string" &&
    typeof o.variantId === "number" &&
    Number.isFinite(o.variantId) &&
    typeof o.qty === "number" &&
    Number.isFinite(o.qty) &&
    (o.unitBreakdown === undefined || typeof o.unitBreakdown === "string") &&
    typeof o.queuedAt === "string"
  );
}

function safeRead(sessionCode: string): QueuedCount[] {
  try {
    const raw = localStorage.getItem(keyFor(sessionCode));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isQueuedCount);
  } catch {
    return [];
  }
}

function safeWrite(sessionCode: string, items: QueuedCount[]): boolean {
  try {
    if (items.length === 0) localStorage.removeItem(keyFor(sessionCode));
    else localStorage.setItem(keyFor(sessionCode), JSON.stringify(items));
    return true;
  } catch {
    // QuotaExceeded / وضع خاص — الواجهة تُعلم المستخدم بدل الانفجار.
    return false;
  }
}

/**
 * إضافة عدّة للطابور. عدّة أحدث لنفس المنتج **تحلّ محل** القديمة غير المُزامَنة
 * (آخر عدّ هو المعتمد — يطابق سلوك تحديث FIRST في الخادم ويمنع تزاحم نسختين).
 * @returns true إن نجح الحفظ محلياً.
 */
export function enqueue(sessionCode: string, item: QueuedCount): boolean {
  const items = safeRead(sessionCode).filter((q) => q.variantId !== item.variantId);
  items.push(item);
  return safeWrite(sessionCode, items);
}

/** كل العناصر المعلّقة بترتيب الإدخال (FIFO) — نسخة للقراءة، لا تُعدَّل مباشرة. */
export function peekAll(sessionCode: string): QueuedCount[] {
  return safeRead(sessionCode);
}

/** إزالة عنصر بعد نجاح مزامنته (أو رفضه خادمياً رفضاً نهائياً). */
export function remove(sessionCode: string, clientRequestId: string): void {
  const items = safeRead(sessionCode);
  const next = items.filter((q) => q.clientRequestId !== clientRequestId);
  if (next.length !== items.length) safeWrite(sessionCode, next);
}

/** عدد العدّات المعلّقة بانتظار المزامنة. */
export function size(sessionCode: string): number {
  return safeRead(sessionCode).length;
}

/**
 * مولّد clientRequestId — UUID v4.
 * `crypto.randomUUID` متاح في السياقات الآمنة فقط (https/localhost)؛ داخل شبكة
 * المتجر (http://192.168.x.x) نولّد v4 عبر `getRandomValues` المتاح في كل السياقات.
 */
export function newClientRequestId(): string {
  const c: Crypto | undefined = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // الإصدار 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // المتغيّر RFC 4122
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
