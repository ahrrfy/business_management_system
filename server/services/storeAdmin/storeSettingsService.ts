/**
 * storeSettingsService — إعدادات المتجر (صفّ مفرد id=1، نمط taxSettings).
 * get-or-default: يعيد الافتراضي إن لم يُنشأ الصفّ بعد (بلا رمي). التحديث upsert على id=1.
 */
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { branches, storeSettings } from "../../../drizzle/schema";
import { getDb, type DB, type Tx } from "../../db";
import { withTx } from "../tx";
import { hasReadyStorefrontCatalog } from "./storefrontReadinessService";

export interface StoreSettingsValue {
  isOpen: boolean;
  fulfillmentBranchId: number | null;
  fulfillmentBranchName: string | null;
  fulfillmentBranchActive: boolean;
  configurationReady: boolean;
  announcement: string | null;
  whatsappNumber: string | null;
  /** عتبة التوصيل المجاني (د.ع نصّاً)؛ null/"0" = معطّل. */
  freeShippingThreshold: string | null;
}

const DEFAULTS: StoreSettingsValue = {
  isOpen: false,
  fulfillmentBranchId: null,
  fulfillmentBranchName: null,
  fulfillmentBranchActive: false,
  configurationReady: false,
  announcement: null,
  whatsappNumber: null,
  freeShippingThreshold: null,
};

async function hasReadyCatalog(
  db: DB | Tx,
  branchId: number,
): Promise<boolean> {
  return hasReadyStorefrontCatalog(db, branchId);
}

export async function getStoreSettings(): Promise<StoreSettingsValue> {
  const db = getDb();
  if (!db) return DEFAULTS;
  // لقطة واحدة حقيقية: لا نقرأ storeSettings هنا ثم نعيد قراءته داخل context primitive.
  // تحت REPEATABLE READ تظل حالة الفتح والفرع والجاهزية من نفس نقطة الزمن؛ لذلك لا
  // يمكن لسباق إغلاق/تبديل الفرع أن يركّب isOpen قديمة على فرع جديد.
  return db.transaction(async (tx) => {
    const row = (
      await tx
        .select()
        .from(storeSettings)
        .where(eq(storeSettings.id, 1))
        .limit(1)
    )[0];
    if (!row) return DEFAULTS;

    const fulfillmentBranchId =
      row.fulfillmentBranchId == null ? null : Number(row.fulfillmentBranchId);
    const branch =
      fulfillmentBranchId == null
        ? null
        : ((
            await tx
              .select({
                id: branches.id,
                name: branches.name,
                isActive: branches.isActive,
              })
              .from(branches)
              .where(eq(branches.id, fulfillmentBranchId))
              .limit(1)
          )[0] ?? null);
    const branchActive = branch?.isActive === true;
    const catalogReady =
      branch && branchActive
        ? await hasReadyCatalog(tx, Number(branch.id))
        : false;
    return {
      isOpen: row.isOpen === true,
      fulfillmentBranchId: branch ? Number(branch.id) : fulfillmentBranchId,
      fulfillmentBranchName: branch?.name ?? null,
      fulfillmentBranchActive: branchActive,
      configurationReady: !!branch && branchActive && catalogReady,
      announcement: row.announcement ?? null,
      whatsappNumber: row.whatsappNumber ?? null,
      freeShippingThreshold: row.freeShippingThreshold ?? null,
    };
  });
}

export async function updateStoreSettings(
  input: Partial<
    Pick<
      StoreSettingsValue,
      | "isOpen"
      | "fulfillmentBranchId"
      | "announcement"
      | "whatsappNumber"
      | "freeShippingThreshold"
    >
  >,
  userId: number,
): Promise<StoreSettingsValue> {
  return withTx(async (tx) => {
    const existing = (
      await tx
        .select()
        .from(storeSettings)
        .where(eq(storeSettings.id, 1))
        .for("update")
        .limit(1)
    )[0];
    const fulfillmentBranchId =
      input.fulfillmentBranchId !== undefined
        ? input.fulfillmentBranchId
        : existing?.fulfillmentBranchId == null
          ? null
          : Number(existing.fulfillmentBranchId);
    let fulfillmentBranchName: string | null = null;
    if (fulfillmentBranchId != null) {
      const branch = (
        await tx
          .select({
            id: branches.id,
            name: branches.name,
            isActive: branches.isActive,
          })
          .from(branches)
          .where(eq(branches.id, fulfillmentBranchId))
          .for("update")
          .limit(1)
      )[0];
      if (!branch)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "فرع تسليم المتجر غير موجود",
        });
      if (branch.isActive !== true) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "لا يمكن تعيين فرع معطّل للمتجر",
        });
      }
      fulfillmentBranchName = branch.name;
    }

    const next = {
      isOpen: input.isOpen ?? (existing ? !!existing.isOpen : DEFAULTS.isOpen),
      fulfillmentBranchId,
      announcement:
        input.announcement !== undefined
          ? input.announcement || null
          : (existing?.announcement ?? null),
      whatsappNumber:
        input.whatsappNumber !== undefined
          ? input.whatsappNumber || null
          : (existing?.whatsappNumber ?? null),
      freeShippingThreshold:
        input.freeShippingThreshold !== undefined
          ? input.freeShippingThreshold || null
          : (existing?.freeShippingThreshold ?? null),
    };
    if (next.isOpen && next.fulfillmentBranchId == null) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "لا يمكن فتح المتجر قبل تعيين فرع تسليم نشط",
      });
    }
    const catalogReady =
      next.fulfillmentBranchId != null
        ? await hasReadyCatalog(tx, next.fulfillmentBranchId)
        : false;
    if (next.isOpen && !catalogReady) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "لا يمكن فتح المتجر: لا يوجد منتج واحد جاهز للبيع في فرع التسليم المحدد",
      });
    }
    if (existing) {
      await tx
        .update(storeSettings)
        .set({ ...next, updatedBy: userId })
        .where(eq(storeSettings.id, 1));
    } else {
      await tx
        .insert(storeSettings)
        .values({ id: 1, ...next, updatedBy: userId });
    }
    return {
      ...next,
      fulfillmentBranchName,
      fulfillmentBranchActive: next.fulfillmentBranchId != null,
      configurationReady: next.fulfillmentBranchId != null && catalogReady,
    };
  });
}

/** الإسقاط العام: عند فساد التهيئة يظهر المتجر مغلقاً، ولا تُعرض حالة فتح كاذبة. */
export async function getPublicStoreSettings(): Promise<StoreSettingsValue> {
  const settings = await getStoreSettings();
  return {
    ...settings,
    isOpen: settings.isOpen && settings.configurationReady,
  };
}
