/**
 * kioskDeviceService — إدارة ومصادقة **أجهزة الكشك الخارجية** (شاشات قارئ الأسعار).
 *
 * نموذج الأمان (انظر تعليق جدول kioskDevices):
 *  - الرمز الخام يُولَّد عشوائياً (24 بايت) ويُعاد **مرّة واحدة فقط** عند الإنشاء/التدوير؛
 *    القاعدة تخزّن تجزئته (sha256) فقط ⇒ لا يكشفها تسريب القاعدة.
 *  - المصادقة تفرض فرع الجهاز من **القاعدة** (المصدر الموثوق) لا من التوكن ⇒ لا IDOR.
 *  - الإلغاء (isActive=false) أو تعطيل الفرع يُبطل الجهاز فوراً على الخادم.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { parse as parseCookie } from "cookie";
import { and, desc, eq } from "drizzle-orm";
import type { Request } from "express";
import { branches, kioskDevices } from "../../drizzle/schema";
import { getDb } from "../db";
import { KIOSK_COOKIE_NAME, verifyKioskSession } from "../auth/kioskSession";

const TOKEN_PREFIX = "kde_";

/** رمز جهاز خام جديد: kde_ + 48 خانة ست عشرية (24 بايت عشوائية). */
export function generateDeviceToken(): string {
  return TOKEN_PREFIX + randomBytes(24).toString("hex");
}

/** تجزئة الرمز للتخزين/البحث — sha256 بالست عشري (64 خانة). */
export function hashDeviceToken(raw: string): string {
  return createHash("sha256").update(String(raw)).digest("hex");
}

function requireDb() {
  const db = getDb();
  if (!db) throw new Error("قاعدة البيانات غير متاحة");
  return db;
}

export interface KioskDeviceRow {
  id: number;
  branchId: number;
  branchName: string | null;
  label: string;
  tokenPrefix: string;
  isActive: boolean;
  lastSeenAt: Date | null;
  lastSeenIp: string | null;
  createdAt: Date | null;
}

/** قائمة الأجهزة للوحة الإدارة (بلا تجزئة الرمز). */
export async function listKioskDevices(): Promise<KioskDeviceRow[]> {
  const db = requireDb();
  const rows = await db
    .select({
      id: kioskDevices.id,
      branchId: kioskDevices.branchId,
      branchName: branches.name,
      label: kioskDevices.label,
      tokenPrefix: kioskDevices.tokenPrefix,
      isActive: kioskDevices.isActive,
      lastSeenAt: kioskDevices.lastSeenAt,
      lastSeenIp: kioskDevices.lastSeenIp,
      createdAt: kioskDevices.createdAt,
    })
    .from(kioskDevices)
    .leftJoin(branches, eq(kioskDevices.branchId, branches.id))
    .orderBy(desc(kioskDevices.createdAt));
  return rows.map((r) => ({ ...r, isActive: Boolean(r.isActive) }));
}

async function assertBranchActive(db: NonNullable<ReturnType<typeof getDb>>, branchId: number) {
  const rows = await db.select({ id: branches.id, isActive: branches.isActive }).from(branches).where(eq(branches.id, branchId)).limit(1);
  const b = rows[0];
  if (!b) throw new Error("الفرع غير موجود");
  if (!b.isActive) throw new Error("الفرع غير مفعّل");
}

/**
 * إنشاء جهاز جديد ⇒ يُعيد الرمز الخام **مرّة واحدة** (لا يُخزَّن ولا يُسترجَع لاحقاً).
 */
export async function createKioskDevice(input: {
  branchId: number;
  label: string;
  createdBy?: number | null;
}): Promise<{ id: number; rawToken: string; tokenPrefix: string }> {
  const db = requireDb();
  await assertBranchActive(db, input.branchId);
  const label = String(input.label ?? "").trim();
  if (!label) throw new Error("اسم الجهاز مطلوب");

  const rawToken = generateDeviceToken();
  const tokenHash = hashDeviceToken(rawToken);
  const tokenPrefix = rawToken.slice(0, 12);

  const res = await db.insert(kioskDevices).values({
    branchId: input.branchId,
    label,
    tokenHash,
    tokenPrefix,
    isActive: true,
    createdBy: input.createdBy ?? null,
  });
  const id = Number((res as any)[0]?.insertId ?? (res as any).insertId);
  return { id, rawToken, tokenPrefix };
}

/** تدوير رمز جهاز قائم ⇒ رمز خام جديد (يُبطل القديم فوراً). */
export async function rotateKioskDevice(id: number): Promise<{ rawToken: string; tokenPrefix: string }> {
  const db = requireDb();
  const rows = await db.select({ id: kioskDevices.id }).from(kioskDevices).where(eq(kioskDevices.id, id)).limit(1);
  if (!rows[0]) throw new Error("الجهاز غير موجود");
  const rawToken = generateDeviceToken();
  const tokenHash = hashDeviceToken(rawToken);
  const tokenPrefix = rawToken.slice(0, 12);
  await db.update(kioskDevices).set({ tokenHash, tokenPrefix, isActive: true, revokedAt: null }).where(eq(kioskDevices.id, id));
  return { rawToken, tokenPrefix };
}

/** تفعيل/إلغاء جهاز (الإلغاء يُبطل توكنه على الخادم فوراً). */
export async function setKioskDeviceActive(id: number, active: boolean): Promise<void> {
  const db = requireDb();
  const rows = await db.select({ id: kioskDevices.id }).from(kioskDevices).where(eq(kioskDevices.id, id)).limit(1);
  if (!rows[0]) throw new Error("الجهاز غير موجود");
  await db
    .update(kioskDevices)
    .set({ isActive: active, revokedAt: active ? null : new Date() })
    .where(eq(kioskDevices.id, id));
}

/** حذف جهاز نهائياً. */
export async function deleteKioskDevice(id: number): Promise<void> {
  const db = requireDb();
  await db.delete(kioskDevices).where(eq(kioskDevices.id, id));
}

/** تجزئة ثابتة الزمن للمقارنة (يُغلق تسريب التوقيت ولو نظرياً). */
function hashEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ba.length !== bb.length || ba.length === 0) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * تسجيل دخول الجهاز بالرمز الخام ⇒ يُعيد هوية الجهاز (الفرع من القاعدة) أو null.
 * يحدّث آخر ظهور والـIP. لا يكشف سبب الفشل (جهاز مجهول/ملغى = null واحد).
 */
export async function deviceLoginByToken(
  rawToken: string,
  ip?: string | null
): Promise<{ deviceId: number; branchId: number; branchName: string | null; label: string; tokenPrefix: string } | null> {
  const code = String(rawToken ?? "").trim();
  if (!code || !code.startsWith(TOKEN_PREFIX)) return null;
  const db = requireDb();
  const tokenHash = hashDeviceToken(code);

  const rows = await db
    .select({
      id: kioskDevices.id,
      branchId: kioskDevices.branchId,
      branchName: branches.name,
      label: kioskDevices.label,
      tokenHash: kioskDevices.tokenHash,
      tokenPrefix: kioskDevices.tokenPrefix,
      isActive: kioskDevices.isActive,
      branchActive: branches.isActive,
    })
    .from(kioskDevices)
    .leftJoin(branches, eq(kioskDevices.branchId, branches.id))
    .where(eq(kioskDevices.tokenHash, tokenHash))
    .limit(1);

  const d = rows[0];
  // مقارنة ثابتة الزمن إضافية رغم أن البحث تمّ بالتجزئة (دفاع عميق).
  if (!d || !hashEquals(d.tokenHash, tokenHash)) return null;
  if (!d.isActive) return null;
  if (d.branchActive === false) return null;

  await db
    .update(kioskDevices)
    .set({ lastSeenAt: new Date(), lastSeenIp: ip ? String(ip).slice(0, 64) : null })
    .where(eq(kioskDevices.id, d.id))
    .catch(() => {});

  return { deviceId: d.id, branchId: d.branchId, branchName: d.branchName ?? null, label: d.label, tokenPrefix: d.tokenPrefix };
}

/** كل خمس دقائق على الأكثر نكتب lastSeenAt (تفادي كتابة لكل قراءة). */
const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;

/**
 * تحليل هوية جهاز الكشك من كوكي الطلب (للقراءات: بنر/بحث الباركود).
 * يتحقّق من التوكن ثم من القاعدة (الجهاز مفعّل + الفرع مفعّل) — والفرع من القاعدة هو المُلزِم.
 * يُعيد null عند أي فشل ⇒ الراوتر يرفض بـUNAUTHORIZED.
 */
export async function resolveKioskDevice(
  req: Request
): Promise<{ deviceId: number; branchId: number; branchName: string | null; label: string } | null> {
  const cookies = parseCookie(req.headers.cookie ?? "");
  const session = await verifyKioskSession(cookies[KIOSK_COOKIE_NAME]);
  if (!session) return null;

  const db = getDb();
  if (!db) return null;

  const rows = await db
    .select({
      id: kioskDevices.id,
      branchId: kioskDevices.branchId,
      branchName: branches.name,
      label: kioskDevices.label,
      tokenPrefix: kioskDevices.tokenPrefix,
      isActive: kioskDevices.isActive,
      lastSeenAt: kioskDevices.lastSeenAt,
      branchActive: branches.isActive,
    })
    .from(kioskDevices)
    .leftJoin(branches, eq(kioskDevices.branchId, branches.id))
    .where(eq(kioskDevices.id, session.deviceId))
    .limit(1);

  const d = rows[0];
  // الإلغاء + تعطيل الفرع يُنفَّذان هنا في **كل قراءة** (لا مسار سريع يثق بالتوكن وحده) ⇒ هذا الفحص حامل للإلغاء.
  if (!d || !d.isActive || d.branchActive === false) return null;
  // تدوير الرمز يغيّر tokenPrefix ⇒ يُرفض أي كوكي وُقِّع ببادئة سابقة (إبطال الجلسات الحيّة عند التدوير).
  if (session.ver !== d.tokenPrefix) return null;

  // نبض ظهور مُخفَّف (best-effort) — لا يُفشل القراءة إن تعثّر.
  const last = d.lastSeenAt ? new Date(d.lastSeenAt).getTime() : 0;
  if (Date.now() - last > LAST_SEEN_THROTTLE_MS) {
    const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() || req.socket?.remoteAddress || null;
    await db.update(kioskDevices).set({ lastSeenAt: new Date(), lastSeenIp: ip ? ip.slice(0, 64) : null }).where(eq(kioskDevices.id, d.id)).catch(() => {});
  }

  // الفرع من القاعدة (المصدر الموثوق) — لا من التوكن.
  return { deviceId: d.id, branchId: d.branchId, branchName: d.branchName ?? null, label: d.label };
}
