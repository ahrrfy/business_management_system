/**
 * storeSettingsService — إعدادات المتجر (صفّ مفرد id=1، نمط taxSettings).
 * get-or-default: يعيد الافتراضي إن لم يُنشأ الصفّ بعد (بلا رمي). التحديث upsert على id=1.
 */
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { branches, storeSettings } from "../../../drizzle/schema";
import { getDb, type DB, type Tx } from "../../db";
import { createTtlCache } from "../../lib/ttlCache";
import { getCurrentCompanyId } from "../../tenancy/context";
import { withTx } from "../tx";
import { hasReadyStorefrontCatalog } from "./storefrontReadinessService";
import { getPublicStorefrontTurnstileSettings } from "../storefrontTurnstile";

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

export interface PublicStoreSettingsValue extends StoreSettingsValue {
  /** بوابة الطلبات العامة؛ false تعني أن التصفح يعمل لكن إنشاء طلب جديد مغلق. */
  orderingEnabled: boolean;
  /** مفتاح Cloudflare العام فقط؛ السر لا يدخل هذا العقد إطلاقاً. */
  turnstileSiteKey: string | null;
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

/**
 * فحص معمارية الحمل ٣٠/٨/٢٦: `hasReadyStorefrontCatalog` مشيٌ متدرّج على الكتالوج
 * (دفعات 256 + فحص توفّرٍ لكلٍّ منها، وأسوأ حالاته مسحُ الكتالوج كاملاً) — وكان يُنفَّذ
 * على **كل** نداء `storefront.settings`، وهو أول ما يطلبه كل زائرٍ مجهول. كاشٌ قصير
 * أحادي الرحلة لمسار القراءة العام وحده؛ مسار الكتابة الإداري (updateStoreSettings)
 * يبقى على الفحص الطازج كي لا تحجب نتيجةٌ قديمة فتحَ المتجر.
 *
 * **الإبطال عبر العمّال بالمفتاح لا بالمسح** (مراجعة Codex على #901): الإنتاج عنقودٌ من
 * ثلاثة عمّال، و`cache.clear()` يمسح كاشَ العامل الذي عالج تحديثَ الإدارة **وحده** —
 * فيبقى العاملان الآخران يردّان «غير جاهز» حتى تنقضي TTL: المالك يفتح المتجر فيراه ثلثا
 * زوّاره مغلقاً دقيقةً كاملة. الحلّ بلا استعلامٍ إضافيّ ولا قناة تواصلٍ بين العمّال:
 * `storeSettings.updatedAt` عمودٌ بـ`ON UPDATE CURRENT_TIMESTAMP` (المخطّط) يُقرأ أصلاً
 * ضمن صفّ الإعدادات ⇒ إدراجه في المفتاح يجعل **أيّ** تحديثٍ للإعدادات يُبطل الكاش على
 * كل العمّال حتماً وفي اللحظة نفسها.
 *
 * التخلّف المتبقّي والمقبول عمداً: تعديلُ **كتالوج** (تفعيل/تعطيل منتج) لا يمسّ
 * `updatedAt` فتبقى الجاهزية متأخّرةً ≤ TTL — وهو ما صُمّمت TTL له، ولا يقلب حالة فتحٍ
 * أقرّها المالك.
 * والمفتاح يتضمّن companyId درءاً لتسريبٍ بين الشركات إن فُعِّل تعدّدها.
 */
const CATALOG_READINESS_TTL_MS = 60_000;
const catalogReadinessCache = createTtlCache<string, boolean>({ ttlMs: CATALOG_READINESS_TTL_MS, maxEntries: 50 });

async function hasReadyCatalogCached(
  db: DB | Tx,
  branchId: number,
  settingsVersion: Date | string | null,
): Promise<boolean> {
  if (process.env.NODE_ENV === "test") return hasReadyCatalog(db, branchId);
  const version =
    settingsVersion instanceof Date ? settingsVersion.getTime() : (settingsVersion ?? "0");
  const key = `${getCurrentCompanyId() ?? 0}:${branchId}:${version}`;
  return catalogReadinessCache.get(key, () => hasReadyCatalog(db, branchId));
}

export async function getStoreSettings(): Promise<StoreSettingsValue> {
  const db = getDb();
  if (!db) return DEFAULTS;
  // لقطة واحدة حقيقية: لا نقرأ storeSettings هنا ثم نعيد قراءته داخل context primitive.
  // تحت REPEATABLE READ تظل حالة الفتح والفرع من نفس نقطة الزمن؛ لذلك لا يمكن لسباق
  // إغلاق/تبديل الفرع أن يركّب isOpen قديمة على فرع جديد.
  // استثناء موثَّق (٣٠/٨): `catalogReady` وحدها قد تأتي من كاشٍ عمره ≤60ث (أدناه) — منطق
  // الفتح/الفرع يبقى لقطةً حيّة، والجاهزية بوليانٌ متسامحٌ مع التأخّر بحكم TTL؛ ومحمّل
  // الكاش يستعمل tx المستدعي الأوّل فقط أثناء انتظاره داخل معاملته المفتوحة (لا يعيش بعدها).
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
        ? await hasReadyCatalogCached(tx, Number(branch.id), row.updatedAt ?? null)
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
    // لا مسحَ للكاش هنا عمداً: `updatedAt` تغيّر بهذه الكتابة (ON UPDATE CURRENT_TIMESTAMP)
    // فصار مفتاح الجاهزية جديداً على **كل** العمّال — مسحٌ محلّيّ كان سيوهم بإبطالٍ شاملٍ
    // لا يقع (راجع التعليق عند catalogReadinessCache).
    return {
      ...next,
      fulfillmentBranchName,
      fulfillmentBranchActive: next.fulfillmentBranchId != null,
      configurationReady: next.fulfillmentBranchId != null && catalogReady,
    };
  });
}

/** الإسقاط العام: عند فساد التهيئة يظهر المتجر مغلقاً، ولا تُعرض حالة فتح كاذبة. */
export async function getPublicStoreSettings(): Promise<PublicStoreSettingsValue> {
  const settings = await getStoreSettings();
  const turnstile = getPublicStorefrontTurnstileSettings();
  return {
    ...settings,
    isOpen: settings.isOpen && settings.configurationReady,
    ...turnstile,
  };
}
