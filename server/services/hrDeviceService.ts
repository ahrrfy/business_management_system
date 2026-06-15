/* ============================================================================
 * خدمة أجهزة البصمة + الهجرة — وحدة الموارد البشرية (server/services/hrDeviceService.ts)
 * هجرة الأجهزة من المزوّد الخارجي المدفوع إلى خادم الرؤية العربية المملوك.
 * القراءة بصلاحية hr/READ والكتابة بـ hr/FULL (في الموجّه). الهجرة عملية ذرّية withTx.
 * ========================================================================== */
import { desc, eq, getTableColumns, sql } from "drizzle-orm";
import { HR_FINGERPRINT_TARGET } from "@shared/hr";
import { branches, hrFingerprintDevices } from "../../drizzle/schema";
import { requireDb, withTx } from "./tx";
import { extractInsertId } from "../lib/insertId";

/** قائمة الأجهزة مع اسم الفرع. الأحدث أولاً. */
export async function listDevices() {
  const db = requireDb();
  const rows = await db
    .select({ ...getTableColumns(hrFingerprintDevices), branchName: branches.name })
    .from(hrFingerprintDevices)
    .leftJoin(branches, eq(hrFingerprintDevices.branchId, branches.id))
    .orderBy(desc(hrFingerprintDevices.id));
  return rows;
}

export async function getDevice(id: number) {
  const db = requireDb();
  const [d] = await db
    .select({ ...getTableColumns(hrFingerprintDevices), branchName: branches.name })
    .from(hrFingerprintDevices)
    .leftJoin(branches, eq(hrFingerprintDevices.branchId, branches.id))
    .where(eq(hrFingerprintDevices.id, id))
    .limit(1);
  return d ?? null;
}

export interface DeviceInput {
  name: string;
  model?: string | null;
  location?: string | null;
  branchId?: number | null;
  deviceCode?: string | null;
  ip?: string | null;
  port?: number | null;
  serverHost?: string | null;
  serverPort?: number | null;
  status?: string | null;
  usersCount?: number | null;
  recordsCount?: number | null;
  firmware?: string | null;
}

function toValues(input: DeviceInput) {
  return {
    name: input.name.trim(),
    model: input.model?.trim() || null,
    location: input.location?.trim() || null,
    branchId: input.branchId ?? null,
    deviceCode: input.deviceCode?.trim() || null,
    ip: input.ip?.trim() || null,
    port: input.port ?? null,
    serverHost: input.serverHost?.trim() || null,
    serverPort: input.serverPort ?? null,
    status: input.status?.trim() || "offline",
    usersCount: input.usersCount ?? 0,
    recordsCount: input.recordsCount ?? 0,
    firmware: input.firmware?.trim() || null,
  };
}

export async function createDevice(input: DeviceInput) {
  const db = requireDb();
  const [res] = await db.insert(hrFingerprintDevices).values({ ...toValues(input), migrated: false });
  return getDevice(extractInsertId(res));
}

export async function updateDevice(id: number, input: DeviceInput) {
  const db = requireDb();
  const [d] = await db.select().from(hrFingerprintDevices).where(eq(hrFingerprintDevices.id, id)).limit(1);
  if (!d) throw new Error("الجهاز غير موجود");
  await db.update(hrFingerprintDevices).set(toValues(input)).where(eq(hrFingerprintDevices.id, id));
  return getDevice(id);
}

/**
 * هجرة الجهاز إلى خادم الرؤية العربية: يُعاد توجيه serverHost/serverPort إلى الوجهة المملوكة
 * ويُرفع علم migrated. عملية ذرّية: إن فشل أي جزء تُلغى كاملة.
 */
export async function migrateDevice(id: number) {
  return withTx(async (tx) => {
    const [d] = await tx.select().from(hrFingerprintDevices).where(eq(hrFingerprintDevices.id, id)).for("update").limit(1);
    if (!d) throw new Error("الجهاز غير موجود");
    // حارس idempotency: لا تُعاد هجرة جهاز مُهاجَر (تجنّب إعادة كتابة الوجهة بصمت).
    if (d.migrated) throw new Error("الجهاز مُهاجَر إلى خادم الرؤية مسبقاً");
    await tx
      .update(hrFingerprintDevices)
      .set({
        serverHost: HR_FINGERPRINT_TARGET.host,
        serverPort: HR_FINGERPRINT_TARGET.port,
        migrated: true,
      })
      .where(eq(hrFingerprintDevices.id, id));
    const [updated] = await tx
      .select({ ...getTableColumns(hrFingerprintDevices), branchName: branches.name })
      .from(hrFingerprintDevices)
      .leftJoin(branches, eq(hrFingerprintDevices.branchId, branches.id))
      .where(eq(hrFingerprintDevices.id, id))
      .limit(1);
    return updated;
  });
}

/** عدّادات الهجرة: الإجمالي / المُهاجَر / المتبقّي. */
export async function migrationStatus() {
  const db = requireDb();
  const [r] = await db
    .select({
      total: sql<number>`count(*)`,
      migrated: sql<number>`sum(case when ${hrFingerprintDevices.migrated} = 1 then 1 else 0 end)`,
    })
    .from(hrFingerprintDevices);
  const total = Number(r?.total ?? 0);
  const migrated = Number(r?.migrated ?? 0);
  return { total, migrated, pending: total - migrated };
}
