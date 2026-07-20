/* ============================================================================
 * سجل الأجهزة + وصلات الاتصال الحية (server/services/hrDevices/registry.ts)
 * التوثيق بالرقم التسلسلي (SN) حصراً: جهاز معروف ومفعَّل يمرّ؛ مجهول يُسجَّل تلقائياً
 * صفاً معطَّلاً (يظهر للمدير ليعتمده) ولا يُقبل منه شيء حتى الاعتماد — بوابة قبول
 * صريحة بلا احتكاك تركيب: وجّه الجهاز لخادمنا فيظهر بنفسه في الشاشة.
 * ========================================================================== */
import { eq, sql } from "drizzle-orm";
import { hrFingerprintDevices } from "../../../drizzle/schema";
import { requireDb } from "../tx";
import { logger } from "../../logger";
import type { DeviceLink, DeviceRow } from "./types";

/** سقف الأجهزة غير المعتمدة المسجَّلة تلقائياً — حارس ضدّ إغراق الجدول/قائمة الاعتماد بأرقام عشوائية. */
const MAX_PENDING_DEVICES = 50;

/** وصلات aiface الحية: deviceId → link (تُستعمل لدفع الأوامر لحظياً ولحالة «متصل الآن»). */
const links = new Map<number, DeviceLink>();

export function registerLink(link: DeviceLink): void {
  // اتصال جديد لنفس الجهاز يطرد القديم (إعادة إقلاع الجهاز تفتح مقبساً جديداً قبل انقضاء القديم).
  const prev = links.get(link.deviceId);
  if (prev && prev !== link) {
    try {
      prev.close();
    } catch {
      /* المقبس القديم ميت أصلاً */
    }
  }
  links.set(link.deviceId, link);
}

export function removeLink(link: DeviceLink): void {
  if (links.get(link.deviceId) === link) links.delete(link.deviceId);
}

export function getLink(deviceId: number): DeviceLink | undefined {
  return links.get(deviceId);
}

export function onlineDeviceIds(): number[] {
  return Array.from(links.keys());
}

/** حلّ جهاز بالرقم التسلسلي؛ المجهول يُنشأ معطَّلاً (enabled=false) باسم واضح للمدير. */
export async function resolveDeviceBySn(serialNumber: string, protocol: string): Promise<DeviceRow | null> {
  const sn = serialNumber.trim();
  if (!sn || sn.length > 64) return null;
  const db = requireDb();
  const [found] = await db
    .select()
    .from(hrFingerprintDevices)
    .where(eq(hrFingerprintDevices.serialNumber, sn))
    .limit(1);
  if (found) return found;
  // حارس إغراق: لا نُنشئ صفاً جديداً إن تجاوز المعلَّق السقف (مضيف مارق يجرّب أرقاماً عشوائية).
  const [pend] = await db
    .select({ n: sql<number>`count(*)` })
    .from(hrFingerprintDevices)
    .where(eq(hrFingerprintDevices.enabled, false));
  if (Number(pend?.n ?? 0) >= MAX_PENDING_DEVICES) {
    logger.warn({ sn }, "hrDevices: تجاوز سقف الأجهزة غير المعتمدة — رُفض تسجيل تلقائي جديد");
    return null;
  }
  try {
    await db.insert(hrFingerprintDevices).values({
      name: `جهاز غير معتمد ${sn}`,
      serialNumber: sn,
      protocol,
      enabled: false,
      migrated: true, // وصل إلى خادمنا فعلاً ⇒ لا معنى لعدّه «غير مُهاجَر»
      status: "offline",
    });
    logger.warn({ sn, protocol }, "hrDevices: جهاز مجهول سجّل نفسه — أُنشئ معطَّلاً بانتظار اعتماد المدير");
  } catch {
    // سباق تسجيلَين متزامنَين لنفس SN — قيد uq_fpdev_serial يحسمه، نعيد القراءة.
  }
  const [row] = await db
    .select()
    .from(hrFingerprintDevices)
    .where(eq(hrFingerprintDevices.serialNumber, sn))
    .limit(1);
  return row ?? null;
}

/** تحديث إشارة الحياة وبيانات المصافحة — devInfo المُبلَّغ يصير مصدر عدادات الشاشة الصادق. */
export async function touchDevice(
  deviceId: number,
  patch: {
    handshake?: boolean;
    devInfo?: unknown;
    firmware?: string;
    usersCount?: number;
    recordsCount?: number;
    lastPunchAt?: string;
  } = {}
): Promise<void> {
  const db = requireDb();
  const set: Record<string, unknown> = { lastSeenAt: sql`CURRENT_TIMESTAMP`, status: "online" };
  if (patch.handshake) set.lastHandshakeAt = sql`CURRENT_TIMESTAMP`;
  if (patch.devInfo !== undefined) set.devInfo = patch.devInfo;
  if (patch.firmware) set.firmware = String(patch.firmware).slice(0, 60);
  if (typeof patch.usersCount === "number") set.usersCount = patch.usersCount;
  if (typeof patch.recordsCount === "number") set.recordsCount = patch.recordsCount;
  if (patch.lastPunchAt) set.lastPunchAt = patch.lastPunchAt;
  await db.update(hrFingerprintDevices).set(set).where(eq(hrFingerprintDevices.id, deviceId));
}

/** وسم الأجهزة الصامتة offline (تُستدعى دورياً من الجسر) — الحالة تُشتق من lastSeenAt لا تُدّعى. */
export async function sweepOffline(quietSeconds: number): Promise<void> {
  const db = requireDb();
  await db
    .update(hrFingerprintDevices)
    .set({ status: "offline" })
    .where(
      sql`${hrFingerprintDevices.status} = 'online' AND (${hrFingerprintDevices.lastSeenAt} IS NULL OR ${hrFingerprintDevices.lastSeenAt} < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ${quietSeconds} SECOND))`
    );
}
