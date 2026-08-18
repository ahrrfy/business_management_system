/* ============================================================================
 * المخزن الخام للبصمات (server/services/hrDevices/punchStore.ts)
 * «التخزين الخام أولاً»: كل بصمة تصل تُكتب فوراً كما هي، والقيد الفريد
 * (serialNumber, enrollId, punchAt) يجعل إعادة الدفع من الجهاز بلا أثر (idempotent) —
 * الجهاز يعيد إرسال مخزونه بعد كل انقطاع، وهذا مرغوب لا خطأ.
 * ========================================================================== */
import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import {
  employees,
  hrAttendancePunches,
  hrDeviceUsers,
  hrFingerprintDevices,
} from "../../../drizzle/schema";
import { requireDb, withTx } from "../tx";
import { logger } from "../../logger";
import type { DeviceRow, RawDeviceUser, RawPunch } from "./types";
import { normalizePunchTime } from "./types";
import { TRPCError } from "@trpc/server";
import type { CompanyBranchScope } from "../companyBranchScope";

/** أقصى قيمة لعمود enrollId (INT موقَّع في MySQL) — تجاوزها يُسقط الدفعة كلها في الوضع الصارم. */
const MAX_ENROLL_ID = 2147483647;

/** إدراج دفعة بصمات خام بشكل idempotent + حلّ الموظف من ربط مستخدمي الجهاز. */
/**
 * هل يسري ربطُ رقم الجهاز بالموظف في هذا اليوم؟ — نواةٌ نقيّة، **الطرفان معاً**.
 *
 * `effectiveFrom`: أرقام الأجهزة تُعاد استعمالها، فسحبُ تاريخ الجهاز كان ينسب حضور موظفٍ
 * سابق للاحقٍ ورثَ رقمه فيدخل راتبَه (0136).
 * `effectiveTo`: الطرف المقابل (0207). كان إنهاءُ الخدمة يقطع الربط **فوراً**، وهو يقع
 * طبيعياً يومَ العمل الأخير نفسه ⇒ بصماتُ ذلك اليوم بلا صاحبٍ فيُسجَّل صفر ساعات.
 *
 * **الحدّان شاملان (inclusive)**: يومُ المباشرة يُحتسب، ويومُ الإنهاء يُحتسب — كلاهما يومُ
 * عملٍ وقع فعلاً وأجرُه مستحقّ. الاستبعاد الحصريّ على أيٍّ منهما يُلغي يوماً مدفوعاً.
 */
export function isLinkEffectiveOn(
  link: { effectiveFrom?: string | null; effectiveTo?: string | null },
  day: string,
): boolean {
  if (link.effectiveFrom && day < link.effectiveFrom) return false;
  if (link.effectiveTo && day > link.effectiveTo) return false;
  return true;
}

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
    .select({
      enrollId: hrDeviceUsers.enrollId,
      employeeId: hrDeviceUsers.employeeId,
      effectiveFrom: hrDeviceUsers.effectiveFrom,
      effectiveTo: hrDeviceUsers.effectiveTo,
    })
    .from(hrDeviceUsers)
    .where(and(eq(hrDeviceUsers.deviceId, device.id), inArray(hrDeviceUsers.enrollId, enrollIds)));
  const linkByEnroll = new Map(users.map((u) => [u.enrollId, u]));

  /**
   * نسبة البصمة للموظف مشروطةٌ بسريان الربط: أرقام الأجهزة تُعاد استعمالها، فرقمٌ يخصّ اليوم
   * موظفاً جديداً قد يحمل في ذاكرة الجهاز سجلّات موظفٍ سابق. سحب التاريخ (getalllog) كان
   * ينسبها للاحق فتدخل راتبه. الأقدم من effectiveFrom تبقى بلا موظف (طابور المراجعة، لا تُرمى).
   */
  function resolveEmployee(enrollId: number, punchAt: string): number | null {
    const link = linkByEnroll.get(enrollId);
    if (!link?.employeeId) return null;
    return isLinkEffectiveOn(link, punchAt.slice(0, 10)) ? link.employeeId : null;
  }

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
          employeeId: resolveEmployee(p.enrollId, p.punchAt),
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
 * ربط مستخدم جهاز بموظف: يُحدّث المرآة ثم يُلحق الربط بالبصمات الخام غير المربوطة
 * لنفس (جهاز، enrollId) — فتدخل دورة الطيّ التالية تلقائياً (لا بصمة تضيع لتأخر الربط).
 *
 * `effectiveFrom` (اختياري، YYYY-MM-DD) يحدّ الإلحاق الرجعيّ: لا تُنسَب بصمةٌ أقدم منه.
 * بدونه كان سحب تاريخ الجهاز ينسب حضور موظفٍ سابق حمل الرقم نفسه للموظف الحالي.
 * يُملأ عادةً من تاريخ مباشرة الموظف؛ null = بلا حدّ (يُستعمل حين لا يُعرف التاريخ).
 */
export async function mapDeviceUserToEmployee(
  deviceId: number,
  enrollId: number,
  employeeId: number | null,
  effectiveFrom?: string | null,
  scope?: CompanyBranchScope,
): Promise<number> {
  // ذرّي: تحديث الربط + إلحاقه بالبصمات السابقة معاً — وإلا مستخدمٌ مربوط وبصماته يتيمة عند فشل جزئي.
  return withTx(async (tx) => {
    if (scope) {
      const [device] = await tx
        .select({ branchId: hrFingerprintDevices.branchId })
        .from(hrFingerprintDevices)
        .where(
          scope.branchId == null
            ? eq(hrFingerprintDevices.id, deviceId)
            : and(
                eq(hrFingerprintDevices.id, deviceId),
                eq(hrFingerprintDevices.branchId, scope.branchId),
              ),
        )
        .for("update")
        .limit(1);
      if (!device) throw new TRPCError({ code: "NOT_FOUND", message: "الجهاز غير موجود" });

      if (employeeId != null) {
        const [employee] = await tx
          .select({ branchId: employees.branchId })
          .from(employees)
          .where(
            scope.branchId == null
              ? eq(employees.id, employeeId)
              : and(eq(employees.id, employeeId), eq(employees.branchId, scope.branchId)),
          )
          .for("update")
          .limit(1);
        if (!employee) throw new TRPCError({ code: "NOT_FOUND", message: "الموظف غير موجود" });
        if (
          device.branchId == null ||
          employee.branchId == null ||
          Number(device.branchId) !== Number(employee.branchId)
        ) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "يجب أن يكون الموظف والجهاز في الفرع نفسه",
          });
        }
      }
    }

    // فكّ الربط يمسح السريان أيضاً، وإلا بقي حدٌّ قديم يحكم ربطاً لاحقاً بموظف آخر بصمت.
    // والحدُّ الأعلى `effectiveTo` **يُمسح في كل ربطٍ أو فكّ** بلا استثناء (0207): موظفٌ أُنهيت
    // خدمتُه ثم أُعيد ربطُه — أو رقمُه أُعطي لموظفٍ جديد — يرث حدَّ الإنهاء القديم فتُهمَل بصماته
    // **صامتةً**. نفس علّة السطر أعلاه، على الطرف المقابل.
    const from = employeeId == null ? null : effectiveFrom || null;
    const [existing] = await tx
      .select({ id: hrDeviceUsers.id })
      .from(hrDeviceUsers)
      .where(and(eq(hrDeviceUsers.deviceId, deviceId), eq(hrDeviceUsers.enrollId, enrollId)))
      .limit(1);
    if (existing) {
      await tx
        .update(hrDeviceUsers)
        .set({ employeeId, effectiveFrom: from, effectiveTo: null })
        .where(eq(hrDeviceUsers.id, existing.id));
    } else {
      await tx.insert(hrDeviceUsers).values({ deviceId, enrollId, employeeId, effectiveFrom: from, effectiveTo: null });
    }
    if (employeeId == null) return 0;
    const conds = [
      eq(hrAttendancePunches.deviceId, deviceId),
      eq(hrAttendancePunches.enrollId, enrollId),
      isNull(hrAttendancePunches.employeeId),
    ];
    // حدّ سارغابل على العمود النصّي مباشرةً (لا DATE(punchAt) — يمسح الجدول ويُعطّل الفهرس).
    if (from) conds.push(gte(hrAttendancePunches.punchAt, `${from} 00:00:00`));
    const res = await tx.update(hrAttendancePunches).set({ employeeId }).where(and(...conds));
    const affected = (res as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 0;
    return Number(affected);
  });
}
