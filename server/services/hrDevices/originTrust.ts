/* ============================================================================
 * ثقة مصدر أجهزة الحضور — «العنوان يُتعلَّم لا يُكتَب»
 * (server/services/hrDevices/originTrust.ts)
 *
 * المشكلة الجذرية (عطل ١١/٨/٢٦): هويّة الجهاز مربوطة بعنوان IP عامّ **يغيّره المزوّد دورياً**
 * (‎.9.235 ⇒ ‎.10.138 ⇒ ‎.10.103)، ومخزَّنة في مكانين ثابتين بلا شاشة: `HR_DEVICE_IP_ALLOWLIST`
 * في ‎.env (يلزمه SSH + إعادة تشغيل) وعمود `ip` في القاعدة. فكلّ تغيير عنوانٍ = انقطاعٌ صامت
 * وتدخّلٌ يدويّ. وجهاز AiFace لا يقبل في إعداداته إلا «نطاق/عنوان + منفذ» — بلا مسار ولا
 * ترويسة ولا توكن ⇒ **مفتاح جهازٍ سرّيّ مستحيلٌ فيزيائياً**، فلا مفرّ من ربطٍ شبكيّ.
 *
 * الحلّ: بدل تجميد العنوان، نجعله **يُستنتَج من دليلٍ مُصادَقٍ عليه**. النظام يعرف عنوان المتجر
 * الحاليّ يقيناً من `userSessions` (جلسات موظّفيه المُصادَقة، ولها `ipAddress` و`lastSeenAt`)،
 * وجهاز البصمة خلف الراوتر نفسه ⇒ العنوان نفسه. فحين يظهر رقمٌ تسلسليٌّ معروف من عنوانٍ جديد
 * **مُعزَّزٍ بجلسة موظّفٍ من فرع الجهاز**، يُعتمَد تلقائياً بأثرٍ تدقيقيّ.
 *
 * ⭐ الأمان لا يضعف: حدّ الثقة يبقى «شبكة المتجر» كما هو اليوم بالضبط — الفرق أنّه يُحدَّث
 * تلقائياً بدل أن يتعفّن. والانتحال يتطلّب الرقم التسلسليّ **و** التواجد على عنوانٍ يعمل منه
 * موظّفٌ مُصادَقٌ من نفس الفرع — أي داخل الحدّ نفسه. وهو أقوى من اكتفاء أغلب أنظمة الحضور
 * بالرقم التسلسليّ وحده.
 *
 * ⏱️ السلوك المتوقَّع عند تغيّر العنوان ليلاً: يبقى الجهاز مصدوداً حتى **أوّل دخول موظّف** من
 * العنوان الجديد (دقائق من بدء الدوام)، ثمّ يُعتمَد ويرفع بصمات الفترة المخزَّنة عنده — لا
 * تضيع بصمة. وإن لم يُعزَّز العنوان أبداً، تظهر المحاولة في الشاشة لاعتمادٍ بنقرة.
 * ========================================================================== */
import { and, eq, sql } from "drizzle-orm";
import {
  hrDeviceOriginAttempts,
  hrFingerprintDevices,
} from "../../../drizzle/schema";
import { requireDb } from "../tx";
import { logger } from "../../logger";
import { isIP } from "node:net";
import { normalizeRemoteAddress, type BridgeSecurityConfig } from "./bridgeSecurity";

/** نافذة اعتبار جلسة الموظّف «قرينةً حيّة» على أنّ العنوان عنوان المتجر. */
const DEFAULT_TRUST_WINDOW_HOURS = 12;
/** سقف مجموعة العناوين المُتعلَّمة — حارس ضدّ انتفاخها بجلسات موظّفين من منازلهم. */
const MAX_LEARNED_ORIGINS = 100;
/** عمر ذاكرة العناوين الموثوقة داخل عملية الجسر (البوّابة الأولى تُستشار بشكل متزامن). */
const ORIGIN_CACHE_TTL_MS = 30_000;

export interface OriginTrustConfig {
  /** الاعتماد التلقائي بالقرينة — مفتاح إيقاف: HR_DEVICE_ORIGIN_AUTOTRUST=0. */
  autoTrust: boolean;
  windowHours: number;
}

export function resolveOriginTrustConfig(
  env: NodeJS.ProcessEnv = process.env,
): OriginTrustConfig {
  const raw = env.HR_DEVICE_ORIGIN_AUTOTRUST?.trim();
  const hours = Number(env.HR_DEVICE_ORIGIN_TRUST_WINDOW_HOURS);
  return {
    // مُفعَّل افتراضياً: الغرض كلّه إنهاء التدخّل اليدويّ. الإيقاف قرارٌ صريح.
    autoTrust: raw !== "0" && raw?.toLowerCase() !== "false",
    windowHours:
      Number.isFinite(hours) && hours >= 1 && hours <= 720
        ? hours
        : DEFAULT_TRUST_WINDOW_HOURS,
  };
}

/* ── ذاكرة العناوين المُتعلَّمة (البوّابة الأولى) ───────────────────────────── */

let learnedOrigins: Set<string> = new Set();
let learnedAt = 0;

/** ما تعلّمه الجسر آخر مرّة — تُقرأ بشكل متزامن داخل verifyClient (لا نداء قاعدة لكل محاولة). */
export function cachedLearnedOrigins(): ReadonlySet<string> {
  return learnedOrigins;
}

export function resetLearnedOriginsForTest(): void {
  learnedOrigins = new Set();
  learnedAt = 0;
}

/**
 * العناوين الموثوقة المُشتقّة من القاعدة:
 *   (١) عناوين الأجهزة المُفعَّلة المخزَّنة — تبقى موثوقة كما اليوم.
 *   (٢) عناوين جلسات الموظّفين المُصادَقة الحيّة في الفروع التي لها أجهزة مُفعَّلة.
 *
 * (٢) هي ما يفتح الباب لعنوان المتجر الجديد **قبل** أن يعرّف الجهاز نفسه — فالبوّابة الأولى
 * ترفض قبل رسالة `reg`. وهي لا تمنح ثقةً بذاتها: البوّابة الثانية تظلّ تطالب برقمٍ تسلسليّ
 * مطابقٍ وقرينةٍ صريحة قبل أيّ اعتماد.
 */
export async function loadLearnedOrigins(windowHours: number): Promise<Set<string>> {
  const db = requireDb();
  const rows = (await db.execute(sql`
    SELECT DISTINCT \`ip\` AS ip FROM (
      SELECT d.\`ip\` AS \`ip\`
        FROM \`hrFingerprintDevices\` d
       WHERE d.\`enabled\` = 1 AND d.\`ip\` IS NOT NULL AND d.\`ip\` <> ''
      UNION
      SELECT s.\`ipAddress\` AS \`ip\`
        FROM \`userSessions\` s
        JOIN \`users\` u ON u.\`id\` = s.\`userId\`
       WHERE s.\`ipAddress\` IS NOT NULL AND s.\`ipAddress\` <> ''
         AND s.\`revokedAt\` IS NULL
         AND s.\`expiresAt\` > CURRENT_TIMESTAMP
         AND s.\`lastSeenAt\` > DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ${windowHours} HOUR)
         AND u.\`isActive\` = 1
         AND EXISTS (
               SELECT 1 FROM \`hrFingerprintDevices\` hd
                WHERE hd.\`enabled\` = 1
                  AND (hd.\`branchId\` IS NULL OR hd.\`branchId\` = u.\`branchId\`)
             )
    ) AS origins
    LIMIT ${MAX_LEARNED_ORIGINS}
  `)) as unknown as Array<Array<{ ip: string | null }>> | Array<{ ip: string | null }>;
  // mysql2 يعيد [rows, fields]؛ drizzle execute يمرّرها كما هي في بعض الإصدارات.
  const list = (Array.isArray(rows[0]) ? rows[0] : rows) as Array<{ ip: string | null }>;
  const out = new Set<string>();
  for (const row of list) {
    const ip = normalizeRemoteAddress(row?.ip ?? undefined);
    if (ip && isIP(ip) !== 0) out.add(ip);
  }
  return out;
}

/** تحديث الذاكرة (يستدعيه الجسر دورياً) — يفشل مفتوحاً: خطأ القاعدة يُبقي آخر مجموعة صالحة. */
export async function refreshLearnedOrigins(windowHours: number): Promise<void> {
  try {
    learnedOrigins = await loadLearnedOrigins(windowHours);
    learnedAt = Date.now();
  } catch (err) {
    logger.warn({ err }, "hrDevices/originTrust: تعذّر تحديث العناوين المُتعلَّمة");
  }
}

export function learnedOriginsAreStale(): boolean {
  return Date.now() - learnedAt > ORIGIN_CACHE_TTL_MS * 4;
}

/* ── القرينة (البوّابة الثانية) ───────────────────────────────────────────── */

/**
 * هل هذا العنوان **مُعزَّزٌ بجلسة موظّفٍ مُصادَقٍ حيّة**؟ إن كان للجهاز فرعٌ، يُشترط أن يكون
 * الموظّف من الفرع نفسه (أضيق وأصدق). الجهاز بلا فرع ⇒ يكفي موظّفٌ فعّالٌ من العنوان نفسه.
 */
export async function isOriginCorroborated(
  branchId: number | null,
  ip: string,
  windowHours: number,
): Promise<boolean> {
  const clean = normalizeRemoteAddress(ip);
  if (!clean || isIP(clean) === 0) return false;
  const db = requireDb();
  const rows = (await db.execute(sql`
    SELECT COUNT(*) AS n
      FROM \`userSessions\` s
      JOIN \`users\` u ON u.\`id\` = s.\`userId\`
       -- الجلسات قد تُخزَّن بصيغة IPv4 المُغلَّفة (::ffff:x) بينما الجسر يرى الصيغة المجرّدة؛
       -- المطابقة على الصيغتين تُبقي المقارنة على العمود نفسه (صديقة للفهرس) بلا دالّة.
     WHERE (s.\`ipAddress\` = ${clean} OR s.\`ipAddress\` = ${`::ffff:${clean}`})
       AND s.\`revokedAt\` IS NULL
       AND s.\`expiresAt\` > CURRENT_TIMESTAMP
       AND s.\`lastSeenAt\` > DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ${windowHours} HOUR)
       AND u.\`isActive\` = 1
       ${branchId != null ? sql`AND u.\`branchId\` = ${branchId}` : sql``}
  `)) as unknown as Array<Array<{ n: number }>> | Array<{ n: number }>;
  const list = (Array.isArray(rows[0]) ? rows[0] : rows) as Array<{ n: number }>;
  return Number(list?.[0]?.n ?? 0) > 0;
}

/* ── سجلّ المحاولات (الرؤية + الاعتماد بنقرة) ─────────────────────────────── */

/**
 * تسجيل محاولةٍ من مصدرٍ غير موثوق. صفٌّ واحد لكل (رقم تسلسليّ، عنوان) مع عدّاد — الجهاز
 * يقرع كلّ ~٢٠٠م.ث عند الرفض، فالإدراج المكرَّر يرفع العدّاد ولا يُنشئ صفاً.
 */
export async function recordOriginAttempt(input: {
  deviceId: number | null;
  serialNumber: string;
  ip: string;
  decision: string;
}): Promise<void> {
  const ip = normalizeRemoteAddress(input.ip);
  const sn = input.serialNumber.trim();
  if (!sn || !ip || isIP(ip) === 0) return;
  try {
    const db = requireDb();
    await db
      .insert(hrDeviceOriginAttempts)
      .values({
        deviceId: input.deviceId,
        serialNumber: sn.slice(0, 64),
        ip: ip.slice(0, 64),
        decision: input.decision.slice(0, 32),
      })
      .onDuplicateKeyUpdate({
        set: {
          attemptCount: sql`${hrDeviceOriginAttempts.attemptCount} + 1`,
          lastSeenAt: sql`CURRENT_TIMESTAMP`,
          decision: input.decision.slice(0, 32),
          deviceId: input.deviceId,
        },
      });
  } catch (err) {
    // الرصد مساعدٌ تشخيصيّ — فشله لا يُسقط مسار الجهاز أبداً.
    logger.warn({ err, sn, ip }, "hrDevices/originTrust: تعذّر تسجيل محاولة مصدر");
  }
}

/** حسم محاولةٍ معلَّقة (اعتماداً تلقائياً أو يدوياً) — يمنع بقاءها في طابور الشاشة. */
export async function resolveOriginAttempt(input: {
  serialNumber: string;
  ip: string;
  resolution: "AUTO" | "MANUAL" | "DISMISSED";
  resolvedBy?: number | null;
}): Promise<void> {
  const ip = normalizeRemoteAddress(input.ip);
  const sn = input.serialNumber.trim();
  if (!sn || !ip) return;
  try {
    const db = requireDb();
    await db
      .update(hrDeviceOriginAttempts)
      .set({
        resolvedAt: sql`CURRENT_TIMESTAMP`,
        resolution: input.resolution,
        resolvedBy: input.resolvedBy ?? null,
      })
      .where(
        and(
          eq(hrDeviceOriginAttempts.serialNumber, sn),
          eq(hrDeviceOriginAttempts.ip, ip),
        ),
      );
  } catch (err) {
    logger.warn({ err, sn, ip }, "hrDevices/originTrust: تعذّر حسم محاولة مصدر");
  }
}

/**
 * اعتماد عنوانٍ جديدٍ لجهاز: يكتب `ip` الجديد ويحسم المحاولة. مصدر الحقيقة يبقى صفّ الجهاز
 * في القاعدة (تقرأه البوّابة الثانية عند كلّ تسجيل) ⇒ **يسري فوراً بلا إعادة تشغيل**.
 */
export async function adoptDeviceOrigin(input: {
  deviceId: number;
  serialNumber: string;
  ip: string;
  resolution: "AUTO" | "MANUAL";
  resolvedBy?: number | null;
}): Promise<void> {
  const ip = normalizeRemoteAddress(input.ip);
  if (!ip || isIP(ip) === 0) throw new Error("HR_ORIGIN_IP_INVALID");
  const db = requireDb();
  await db
    .update(hrFingerprintDevices)
    .set({ ip })
    .where(eq(hrFingerprintDevices.id, input.deviceId));
  await resolveOriginAttempt({
    serialNumber: input.serialNumber,
    ip,
    resolution: input.resolution,
    resolvedBy: input.resolvedBy ?? null,
  });
  // العنوان الجديد يدخل الذاكرة فوراً كي لا تُصَدّ إعادةُ الاتصال التالية قبل دورة التحديث.
  learnedOrigins.add(ip);
}

export interface PendingOriginAttempt {
  id: number;
  deviceId: number | null;
  deviceName: string | null;
  serialNumber: string;
  ip: string;
  decision: string;
  attemptCount: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

/**
 * المحاولات المعلّقة لتظهر في الشاشة — الرؤية هي نصف الحلّ: العطل الأصليّ دام ٨ ساعات لأنّ
 * الرفض كان يُدفن في ملفّ سجلّ لا يقرؤه أحد.
 */
export async function listPendingOriginAttempts(limit = 20): Promise<PendingOriginAttempt[]> {
  const db = requireDb();
  const rows = await db
    .select({
      id: hrDeviceOriginAttempts.id,
      deviceId: hrDeviceOriginAttempts.deviceId,
      deviceName: hrFingerprintDevices.name,
      serialNumber: hrDeviceOriginAttempts.serialNumber,
      ip: hrDeviceOriginAttempts.ip,
      decision: hrDeviceOriginAttempts.decision,
      attemptCount: hrDeviceOriginAttempts.attemptCount,
      firstSeenAt: hrDeviceOriginAttempts.firstSeenAt,
      lastSeenAt: hrDeviceOriginAttempts.lastSeenAt,
    })
    .from(hrDeviceOriginAttempts)
    .leftJoin(
      hrFingerprintDevices,
      eq(hrFingerprintDevices.id, hrDeviceOriginAttempts.deviceId),
    )
    .where(sql`${hrDeviceOriginAttempts.resolvedAt} IS NULL`)
    .orderBy(sql`${hrDeviceOriginAttempts.lastSeenAt} DESC`)
    .limit(Math.min(Math.max(limit, 1), 100));
  return rows as PendingOriginAttempt[];
}

/** صفّ محاولةٍ بعينه (لاعتمادٍ يدويّ من الشاشة) — مع الجهاز المرتبط للتحقّق قبل الكتابة. */
export async function getOriginAttempt(id: number): Promise<
  (PendingOriginAttempt & { resolvedAt: Date | null }) | null
> {
  const db = requireDb();
  const [row] = await db
    .select({
      id: hrDeviceOriginAttempts.id,
      deviceId: hrDeviceOriginAttempts.deviceId,
      deviceName: hrFingerprintDevices.name,
      serialNumber: hrDeviceOriginAttempts.serialNumber,
      ip: hrDeviceOriginAttempts.ip,
      decision: hrDeviceOriginAttempts.decision,
      attemptCount: hrDeviceOriginAttempts.attemptCount,
      firstSeenAt: hrDeviceOriginAttempts.firstSeenAt,
      lastSeenAt: hrDeviceOriginAttempts.lastSeenAt,
      resolvedAt: hrDeviceOriginAttempts.resolvedAt,
    })
    .from(hrDeviceOriginAttempts)
    .leftJoin(
      hrFingerprintDevices,
      eq(hrFingerprintDevices.id, hrDeviceOriginAttempts.deviceId),
    )
    .where(eq(hrDeviceOriginAttempts.id, id))
    .limit(1);
  return (row as (PendingOriginAttempt & { resolvedAt: Date | null }) | undefined) ?? null;
}

/**
 * القرار الكامل عند رفض الهويّة: هل نعتمد العنوان تلقائياً؟
 * الربط الصريح في ‎.env (`HR_DEVICE_IDENTITY_BINDINGS`) **يغلب دائماً** — نيّة المشغّل الصريحة
 * لا يجوز أن يدهسها تعلُّمٌ تلقائيّ.
 */
export async function tryAutoAdoptOrigin(input: {
  device: { id: number; branchId: number | null };
  serialNumber: string;
  ip: string;
  decision: string;
  security: BridgeSecurityConfig;
  config?: OriginTrustConfig;
}): Promise<{ adopted: boolean; reason: string }> {
  const cfg = input.config ?? resolveOriginTrustConfig();
  await recordOriginAttempt({
    deviceId: input.device.id,
    serialNumber: input.serialNumber,
    ip: input.ip,
    decision: input.decision,
  });
  if (!cfg.autoTrust) return { adopted: false, reason: "AUTOTRUST_DISABLED" };
  if (input.security.deviceIdentityBindings[input.serialNumber.trim()]) {
    return { adopted: false, reason: "EXPLICIT_BINDING_WINS" };
  }
  const corroborated = await isOriginCorroborated(
    input.device.branchId,
    input.ip,
    cfg.windowHours,
  );
  if (!corroborated) return { adopted: false, reason: "NOT_CORROBORATED" };
  await adoptDeviceOrigin({
    deviceId: input.device.id,
    serialNumber: input.serialNumber,
    ip: input.ip,
    resolution: "AUTO",
  });
  return { adopted: true, reason: "CORROBORATED_BY_SESSION" };
}
