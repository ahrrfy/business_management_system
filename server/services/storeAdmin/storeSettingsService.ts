/**
 * storeSettingsService — إعدادات المتجر (صفّ مفرد id=1، نمط taxSettings).
 * get-or-default: يعيد الافتراضي إن لم يُنشأ الصفّ بعد (بلا رمي). التحديث upsert على id=1.
 */
import { eq } from "drizzle-orm";
import { storeSettings } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { withTx } from "../tx";

export interface StoreSettingsValue {
  isOpen: boolean;
  announcement: string | null;
  whatsappNumber: string | null;
  /** عتبة التوصيل المجاني (د.ع نصّاً)؛ null/"0" = معطّل. */
  freeShippingThreshold: string | null;
}

const DEFAULTS: StoreSettingsValue = { isOpen: true, announcement: null, whatsappNumber: null, freeShippingThreshold: null };

export async function getStoreSettings(): Promise<StoreSettingsValue> {
  const db = getDb();
  if (!db) return DEFAULTS;
  const row = (await db.select().from(storeSettings).where(eq(storeSettings.id, 1)).limit(1))[0];
  if (!row) return DEFAULTS;
  return {
    isOpen: !!row.isOpen,
    announcement: row.announcement ?? null,
    whatsappNumber: row.whatsappNumber ?? null,
    freeShippingThreshold: row.freeShippingThreshold ?? null,
  };
}

export async function updateStoreSettings(
  input: Partial<StoreSettingsValue>,
  userId: number
): Promise<StoreSettingsValue> {
  return withTx(async (tx) => {
    const existing = (await tx.select().from(storeSettings).where(eq(storeSettings.id, 1)).limit(1))[0];
    const next: StoreSettingsValue = {
      isOpen: input.isOpen ?? (existing ? !!existing.isOpen : DEFAULTS.isOpen),
      announcement: input.announcement !== undefined ? (input.announcement || null) : existing?.announcement ?? null,
      whatsappNumber: input.whatsappNumber !== undefined ? (input.whatsappNumber || null) : existing?.whatsappNumber ?? null,
      freeShippingThreshold:
        input.freeShippingThreshold !== undefined ? (input.freeShippingThreshold || null) : existing?.freeShippingThreshold ?? null,
    };
    if (existing) {
      await tx.update(storeSettings).set({ ...next, updatedBy: userId }).where(eq(storeSettings.id, 1));
    } else {
      await tx.insert(storeSettings).values({ id: 1, ...next, updatedBy: userId });
    }
    return next;
  });
}
