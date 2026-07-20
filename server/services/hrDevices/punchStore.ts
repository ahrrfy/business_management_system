/* ============================================================================
 * المخزن الخام للبصمات (server/services/hrDevices/punchStore.ts)
 * «التخزين الخام أولاً»: كل بصمة تصل تُكتب فوراً كما هي، والقيد الفريد
 * (serialNumber, enrollId, punchAt) يجعل إعادة الدفع من الجهاز بلا أثر (idempotent) —
 * الجهاز يعيد إرسال مخزونه بعد كل انقطاع، وهذا مرغوب لا خطأ.
 * ========================================================================== */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { hrAttendancePunches, hrDeviceUsers } from "../../../drizzle/schema";
import { requireDb, withTx } from "../tx";
import { logger } from "../../logger";
import type { DeviceRow, RawDeviceUser, RawPunch } from "./types";
import { normalizePunchTime } from "./types";

/** أقصى قيمة لعمود enrollId (INT موقَّع في MySQL) — تجاوزها يُسقط الدفعة كلها في الوضع الصارم. */
const MAX_ENROLL_ID = 2147483647;

/** إدراج دفعة بصمات خام بشكل idempotent + حلّ الموظف من ربط مستخدمي الجهاز. */
export async function ingestPunches(
  device: DeviceRow,
  punches: RawPunch[]
): Promise<{ accepted: number; rejected: number; lastPunchAt: string | null }> {
  const db = requireDb();
  const sn = device.serialNumber ?? "";
  const valid: Array<RawPunch & { punchAt: string }> = [];
  let rejected = 0;
  for (const p of punches) {
    const t = normalizePunchTime(p.punchAt);
    const enrollId = Number(p.enrollId);
    // الحدّ الأعلى حاسم: enrollId خارج مدى INT كان سيُفشل عبارة الإدراج المجمَّعة كلها (٥٠٠ صف)
    // فيُفقد بصمات مشروعة لموظفين آخرين معه — نرفضه فردياً هنا (تدقيق عدائي).
    if (!t || !Number.isInteger(enrollId) || enrollId < 0 || enrollId > MAX_ENROLL_ID) {
      rejected++;
      continue;
    }
    valid.push({ ...p, enrollId, punchAt: t });
  }
  if (valid.length === 0) return { accepted: 0, rejected, lastPunchAt: null };

  // ربط enrollId → employeeId دفعة واحدة (مصدر الحقيقة: hrDeviceUsers).
  const enrollIds = Array.from(new Set(valid.map((p) => p.enrollId)));
  const users = await db
    .select({ enrollId: hrDeviceUsers.enrollId, employeeId: hrDeviceUsers.employeeId })
    .from(hrDeviceUsers)
    .where(and(eq(hrDeviceUsers.deviceId, device.id), inArray(hrDeviceUsers.enrollId, enrollIds)));
  const empByEnroll = new Map(users.map((u) => [u.enrollId, u.employeeId]));

  // إدراج مجزّأ مع no-op عند التكرار (نمط idempotency في §٥ — القيد يحسم لا الفحص المسبق).
  let lastPunchAt: string | null = null;
  for (let i = 0; i < valid.length; i += 500) {
    const chunk = valid.slice(i, i + 500);
    await db
      .insert(hrAttendancePunches)
      .values(
        chunk.map((p) => ({
          deviceId: device.id,
          serialNumber: sn,
          enrollId: p.enrollId,
          punchAt: p.punchAt,
          mode: p.mode?.slice(0, 12) ?? null,
          inOut: p.inOut?.slice(0, 8) ?? null,
          employeeId: empByEnroll.get(p.enrollId) ?? null,
          raw: p.raw ?? null,
        }))
      )
      .onDuplicateKeyUpdate({ set: { serialNumber: sql`${hrAttendancePunches.serialNumber}` } });
    for (const p of chunk) if (!lastPunchAt || p.punchAt > lastPunchAt) lastPunchAt = p.punchAt;
  }
  logger.info({ sn, count: valid.length, rejected }, "hrDevices: استلام بصمات");
  return { accepted: valid.length, rejected, lastPunchAt };
}

/** ترقية مرآة مستخدم جهاز (من senduser/getuserlist/OPERLOG) — لا يمسّ ربط employeeId القائم. */
export async function upsertDeviceUser(device: DeviceRow, u: RawDeviceUser): Promise<void> {
  const db = requireDb();
  const enrollId = Number(u.enrollId);
  if (!Number.isInteger(enrollId) || enrollId < 0) return;
  const [existing] = await db
    .select()
    .from(hrDeviceUsers)
    .where(and(eq(hrDeviceUsers.deviceId, device.id), eq(hrDeviceUsers.enrollId, enrollId)))
    .limit(1);
  const backupPatch =
    u.backup !== undefined
      ? {
          backupData: {
            ...(existing?.backupData && typeof existing.backupData === "object" ? (existing.backupData as object) : {}),
            [String(u.backup.num)]: u.backup.record,
          },
        }
      : {};
  if (existing) {
    await db
      .update(hrDeviceUsers)
      .set({
        name: u.name?.slice(0, 120) ?? existing.name,
        isAdmin: u.isAdmin ?? existing.isAdmin,
        cardNo: u.cardNo?.slice(0, 40) ?? existing.cardNo,
        syncedAt: sql`CURRENT_TIMESTAMP`,
        ...backupPatch,
      })
      .where(eq(hrDeviceUsers.id, existing.id));
  } else {
    await db.insert(hrDeviceUsers).values({
      deviceId: device.id,
      enrollId,
      name: u.name?.slice(0, 120) ?? null,
      isAdmin: u.isAdmin ?? false,
      cardNo: u.cardNo?.slice(0, 40) ?? null,
      syncedAt: sql`CURRENT_TIMESTAMP`,
      ...("backupData" in backupPatch ? backupPatch : {}),
    });
  }
}

/**
 * ربط مستخدم جهاز بموظف: يُحدّث المرآة ثم يُلحق الربط بكل البصمات الخام غير المربوطة
 * لنفس (جهاز، enrollId) — فتدخل دورة الطيّ التالية تلقائياً (لا بصمة تضيع لتأخر الربط).
 */
export async function mapDeviceUserToEmployee(
  deviceId: number,
  enrollId: number,
  employeeId: number | null
): Promise<number> {
  // ذرّي: تحديث الربط + إلحاقه بالبصمات السابقة معاً — وإلا مستخدمٌ مربوط وبصماته يتيمة عند فشل جزئي.
  return withTx(async (tx) => {
    const [existing] = await tx
      .select({ id: hrDeviceUsers.id })
      .from(hrDeviceUsers)
      .where(and(eq(hrDeviceUsers.deviceId, deviceId), eq(hrDeviceUsers.enrollId, enrollId)))
      .limit(1);
    if (existing) {
      await tx.update(hrDeviceUsers).set({ employeeId }).where(eq(hrDeviceUsers.id, existing.id));
    } else {
      await tx.insert(hrDeviceUsers).values({ deviceId, enrollId, employeeId });
    }
    if (employeeId == null) return 0;
    const res = await tx
      .update(hrAttendancePunches)
      .set({ employeeId })
      .where(
        and(
          eq(hrAttendancePunches.deviceId, deviceId),
          eq(hrAttendancePunches.enrollId, enrollId),
          isNull(hrAttendancePunches.employeeId)
        )
      );
    const affected = (res as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 0;
    return Number(affected);
  });
}
