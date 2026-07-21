/**
 * إعدادات «استوديو صور المنتجات» (singleton id=1) — إدارة مفتاح remove.bg المشفَّر ومفتاح تفعيل
 * مسار Pro. شريحة ٥ (Pro).
 *
 * المنطق (نمط integrationService):
 *   - المفتاح يُخزَّن مشفَّراً (AES-256-GCM عبر cryptoService) ولا يُعرَض نصّاً أبداً (قناع فقط).
 *   - `getProConfig` (عام لأي مصادَق): proAvailable = proEnabled ∧ مفتاح موجود ∧ crypto جاهز
 *     ⇒ الواجهة تعرف هل تُحاول Pro. لا يسرّب المفتاح.
 *   - `getDecryptedRemovebgKey` نقطة-استعمال (يُدعى من الراوتر لحظة القصّ فقط، لا cache).
 *   - بوّابة صلبة: **لا تفعيل Pro بلا مفتاح** (خادمياً) — وإلا وضعٌ «مُفعَّل بلا عقل».
 *
 * RBAC: الراوتر يفرض adminProcedure على الكتابة/الفحص (مفتاح مدفوع = قرار مالك/مدير).
 */

import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { imageStudioSettings } from "../../drizzle/schema";
import { getDb } from "../db";
import { decryptSecret, encryptSecret, isCryptoReady, maskSecret } from "./cryptoService";
import { getRemovebgAccount, RemovebgError, removebgErrorMessageAr } from "./removebgService";
import { withTx } from "./tx";

export interface ImageStudioSettingsDisplay {
  proEnabled: boolean;
  hasKey: boolean;
  /** قناع آمن ('••••abcd') أو null — أبداً نصّاً كاملاً. */
  removebgKeyMasked: string | null;
  lastVerifiedAt: Date | null;
  lastError: string | null;
  /** هل INTEGRATIONS_ENCRYPTION_KEY مضبوط (بدونه لا يُحفَظ مفتاح). */
  cryptoReady: boolean;
}

/** decrypt آمن (لا throw يكسر العرض لو تلاعب/تغيّر المفتاح الرئيسي). */
function safeDecrypt(ciphertext: string | null): string | null {
  if (!ciphertext) return null;
  try {
    return decryptSecret(ciphertext);
  } catch {
    return null;
  }
}

/** يقرأ الصفّ المفرد (أوّل صفّ) أو null. */
async function readRow() {
  const db = getDb();
  if (!db) return null;
  return (
    await db
      .select({
        id: imageStudioSettings.id,
        proEnabled: imageStudioSettings.proEnabled,
        encryptedRemovebgKey: imageStudioSettings.encryptedRemovebgKey,
        lastVerifiedAt: imageStudioSettings.lastVerifiedAt,
        lastError: imageStudioSettings.lastError,
      })
      .from(imageStudioSettings)
      .orderBy(imageStudioSettings.id)
      .limit(1)
  )[0] ?? null;
}

/** إعدادات العرض (مُقنَّعة). لو لا صفّ ⇒ افتراضات (Pro مطفأ، لا مفتاح). */
export async function getImageStudioSettings(): Promise<ImageStudioSettingsDisplay> {
  const row = await readRow();
  const key = safeDecrypt(row?.encryptedRemovebgKey ?? null);
  return {
    proEnabled: !!row?.proEnabled,
    hasKey: !!key,
    removebgKeyMasked: maskSecret(key),
    lastVerifiedAt: row?.lastVerifiedAt ?? null,
    lastError: row?.lastError ?? null,
    cryptoReady: isCryptoReady(),
  };
}

/** إعداد عام لأي مصادَق: هل مسار Pro متاح فعلياً (لتقرّر الواجهة المحاولة). لا يسرّب المفتاح. */
export async function getProConfig(): Promise<{ proAvailable: boolean }> {
  const row = await readRow();
  const key = safeDecrypt(row?.encryptedRemovebgKey ?? null);
  return { proAvailable: !!row?.proEnabled && !!key && isCryptoReady() };
}

/** المفتاح مفكوكاً — لنقطة الاستعمال (الراوتر لحظة القصّ) فقط. null لو مطفأ/غير مضبوط. */
export async function getDecryptedRemovebgKey(): Promise<string | null> {
  const row = await readRow();
  if (!row?.proEnabled) return null;
  return safeDecrypt(row.encryptedRemovebgKey);
}

export interface UpdateImageStudioSettingsInput {
  proEnabled?: boolean;
  /** undefined = لا تُغيّر؛ null = امسح؛ string = اكتب مفتاحاً جديداً. */
  removebgKey?: string | null;
}

/** يكتب/يُحدّث الصفّ المفرد. بوّابة: لا تفعيل Pro بلا مفتاح (خادمياً). */
export async function updateImageStudioSettings(
  input: UpdateImageStudioSettingsInput,
  updatedBy: number,
): Promise<void> {
  const settingKey = input.removebgKey !== undefined;
  if (settingKey && input.removebgKey && !isCryptoReady()) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "INTEGRATIONS_ENCRYPTION_KEY غير مضبوط في .env — أضِفه قبل حفظ مفتاح remove.bg.",
    });
  }

  await withTx(async (tx) => {
    const existing = (
      await tx
        .select({ id: imageStudioSettings.id, encryptedRemovebgKey: imageStudioSettings.encryptedRemovebgKey })
        .from(imageStudioSettings)
        .orderBy(imageStudioSettings.id)
        .limit(1)
    )[0];

    // المفتاح النهائي بعد هذا التحديث (لبوّابة «لا تفعيل بلا مفتاح»).
    const keyAfter =
      input.removebgKey === undefined
        ? safeDecrypt(existing?.encryptedRemovebgKey ?? null)
        : input.removebgKey; // string جديد أو null (مسح)

    if (input.proEnabled === true && !keyAfter) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "لا يمكن تفعيل مسار Pro بلا مفتاح remove.bg. أدخِل المفتاح أولاً.",
      });
    }

    const patch: Record<string, unknown> = { updatedBy };
    if (input.proEnabled !== undefined) patch.proEnabled = input.proEnabled;
    if (input.removebgKey !== undefined) {
      patch.encryptedRemovebgKey = input.removebgKey ? encryptSecret(input.removebgKey) : null;
      // تغيير المفتاح ⇒ صفّر حالة الفحص السابقة (يلزم فحص جديد).
      patch.lastVerifiedAt = null;
      patch.lastError = null;
      // مسح المفتاح ⇒ عطّل Pro حتماً (لا يبقى مُفعَّلاً بلا مفتاح).
      if (!input.removebgKey && input.proEnabled === undefined) patch.proEnabled = false;
    }

    if (existing) {
      await tx.update(imageStudioSettings).set(patch).where(eq(imageStudioSettings.id, existing.id));
    } else {
      await tx.insert(imageStudioSettings).values({
        proEnabled: input.proEnabled ?? false,
        encryptedRemovebgKey: input.removebgKey ? encryptSecret(input.removebgKey) : null,
        updatedBy,
      });
    }
  });
}

/** يفحص المفتاح فعلياً (GET /account، بلا اقتطاع رصيد) ويكتب النتيجة. */
export async function verifyRemovebgConnection(): Promise<{ ok: boolean; message: string }> {
  const key = await (async () => {
    const row = await readRow();
    return safeDecrypt(row?.encryptedRemovebgKey ?? null);
  })();
  if (!key) {
    return { ok: false, message: "لا مفتاح remove.bg محفوظ." };
  }

  let result: { ok: boolean; message: string };
  try {
    const acct = await getRemovebgAccount(key);
    const parts: string[] = ["المفتاح صالح."];
    if (acct.totalCredits != null) parts.push(`الرصيد: ${acct.totalCredits}`);
    if (acct.freeApiCalls != null) parts.push(`نداءات مجانية متبقّية: ${acct.freeApiCalls}`);
    result = { ok: true, message: parts.join(" ") };
  } catch (e) {
    const msg = e instanceof RemovebgError ? removebgErrorMessageAr(e.kind) : "فشل الفحص.";
    result = { ok: false, message: msg };
  }

  // اكتب النتيجة على الصفّ المفرد.
  await withTx(async (tx) => {
    const existing = (
      await tx.select({ id: imageStudioSettings.id }).from(imageStudioSettings).orderBy(imageStudioSettings.id).limit(1)
    )[0];
    if (existing) {
      await tx
        .update(imageStudioSettings)
        .set({ lastVerifiedAt: result.ok ? new Date() : null, lastError: result.ok ? null : result.message.slice(0, 500) })
        .where(eq(imageStudioSettings.id, existing.id));
    }
  });

  return result;
}
