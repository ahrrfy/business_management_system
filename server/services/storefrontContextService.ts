import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { branches, storeSettings } from "../../drizzle/schema";
import type { DB, Tx } from "../db";
import { requireDb } from "./tx";

export interface StorefrontOperationalContext {
  branchId: number;
  branchName: string;
  isOpen: boolean;
}

export interface StorefrontContextInspection {
  configured: boolean;
  branchId: number | null;
  branchName: string | null;
  branchActive: boolean;
  requestedOpen: boolean;
  operational: boolean;
}

type QueryDb = DB | Tx;

async function readSettingsRow(db: QueryDb, lock: boolean) {
  const query = db
    .select({
      isOpen: storeSettings.isOpen,
      fulfillmentBranchId: storeSettings.fulfillmentBranchId,
    })
    .from(storeSettings)
    .where(eq(storeSettings.id, 1))
    .limit(1);
  // فحص الحمل ٣٠/٨/٢٦: كان القفل هنا FOR UPDATE ⇒ **قفلٌ حصريّ عالميّ** على صفّ الإعدادات
  // الوحيد يحمله كلُّ طلب متجرٍ حتى COMMIT، فيتسلسل كل طلبات المتجر خلف أبطئها (انقلاب أولوية:
  // كاشير بطيء يجمّد المتجر كلّه). الضمانة المطلوبة — «تثبيت اختيار الفرع/الفتح طوال الطلب» —
  // يحقّقها FOR SHARE بلا تسلسل: الطلبات قارئة لا تكتب الصفّ أبداً (الكاتب الوحيد
  // updateStoreSettings يأخذ X خاصّته فيُحجَب حتى تلتزم الطلبات الحاملة S، وS يمنع X أثناءها).
  // ولا خطر ترقية S→X هنا لأن معاملات الطلب لا تكتب storeSettings إطلاقاً.
  return (lock ? await query.for("share") : await query)[0];
}

type RowLock = false | "update" | "share";

async function readBranchRow(db: QueryDb, branchId: number, lock: RowLock) {
  const query = db
    .select({ id: branches.id, name: branches.name, isActive: branches.isActive })
    .from(branches)
    .where(eq(branches.id, branchId))
    .limit(1);
  return (lock ? await query.for(lock) : await query)[0];
}

/**
 * يفحص مرجع فرع المتجر كما هو، بلا أي fallback إلى MAIN/أول فرع/الرقم 1.
 * يُستعمل العرض التشخيصي في الإعدادات العامة حتى يبقى المتجر مغلقاً بأمان عند نقص التهيئة.
 */
export async function inspectStorefrontContext(
  db: QueryDb = requireDb(),
  options: { lock?: boolean; branchLock?: "update" | "share" } = {},
): Promise<StorefrontContextInspection> {
  const lock = options.lock === true;
  const settings = await readSettingsRow(db, lock);
  const requestedOpen = settings?.isOpen === true;
  const configuredBranchId = settings?.fulfillmentBranchId == null
    ? null
    : Number(settings.fulfillmentBranchId);
  if (configuredBranchId == null || configuredBranchId <= 0) {
    return {
      configured: false,
      branchId: null,
      branchName: null,
      branchActive: false,
      requestedOpen,
      operational: false,
    };
  }

  const branch = await readBranchRow(
    db,
    configuredBranchId,
    lock ? (options.branchLock ?? "update") : false,
  );
  const branchActive = branch?.isActive === true;
  return {
    configured: !!branch,
    branchId: branch ? Number(branch.id) : configuredBranchId,
    branchName: branch?.name ?? null,
    branchActive,
    requestedOpen,
    operational: !!branch && branchActive && requestedOpen,
  };
}

/** المصدر الوحيد لفرع الكتالوج والطلب ولوحة المتجر. */
export async function requireStorefrontContext(
  db: QueryDb = requireDb(),
  options: { requireOpen?: boolean; lock?: boolean; branchLock?: "update" | "share" } = {},
): Promise<StorefrontOperationalContext> {
  const context = await inspectStorefrontContext(db, {
    lock: options.lock,
    branchLock: options.branchLock,
  });
  if (!context.configured || context.branchId == null || context.branchName == null) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "لم يُعيَّن فرع تسليم صالح للمتجر — أغلق المتجر وعيّن فرعاً من الإعدادات",
    });
  }
  if (!context.branchActive) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "فرع تسليم المتجر معطّل — أعد تفعيله أو عيّن فرعاً نشطاً قبل التشغيل",
    });
  }
  if (options.requireOpen && !context.requestedOpen) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "المتجر مغلق مؤقتاً — لا يمكن استلام الطلبات حالياً",
    });
  }
  return {
    branchId: context.branchId,
    branchName: context.branchName,
    isOpen: context.requestedOpen,
  };
}

/** التحقق من فرع صريح لمسارات إدارية عامة؛ لا يُستخدم بديلاً عن فرع المتجر المعيّن. */
export async function requireActiveBranch(branchId: number, db: QueryDb = requireDb()): Promise<number> {
  if (!Number.isSafeInteger(branchId) || branchId <= 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "معرّف الفرع غير صالح" });
  }
  const branch = await readBranchRow(db, branchId, false);
  if (!branch) throw new TRPCError({ code: "NOT_FOUND", message: "الفرع غير موجود" });
  if (branch.isActive !== true) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "الفرع معطّل" });
  }
  return Number(branch.id);
}
