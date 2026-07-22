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
import {
  AI_STUDIO_PROVIDERS,
  DEFAULT_AI_STUDIO_PROMPT,
  DEFAULT_GEMINI_IMAGE_MODEL,
  MAX_STUDIO_PROMPT_LEN,
  type AiStudioProvider,
} from "@shared/imageStudio/aiPrompt";
import { imageStudioSettings } from "../../drizzle/schema";
import { getDb } from "../db";
import { AiImageError, aiImageErrorMessageAr, isModelAvailable, verifyGeminiKey } from "./aiImageStudioService";
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
        aiEnabled: imageStudioSettings.aiEnabled,
        aiProvider: imageStudioSettings.aiProvider,
        aiModel: imageStudioSettings.aiModel,
        encryptedAiKey: imageStudioSettings.encryptedAiKey,
        aiStudioPrompt: imageStudioSettings.aiStudioPrompt,
        aiLastVerifiedAt: imageStudioSettings.aiLastVerifiedAt,
        aiLastError: imageStudioSettings.aiLastError,
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
    // يضمن الصفّ المفرد (id=1) ذرّيّاً (نمط taxSettings) — يمنع تسابق كاتبَي remove.bg والذكاء
    // الاصطناعي على مستأجرٍ جديد من إدراج صفّين مستقلّين يُفقِد أحدهما (readRow يقرأ الأوّل فقط).
    await tx.insert(imageStudioSettings).values({ id: 1 }).onDuplicateKeyUpdate({ set: { id: 1 } });
    const existing = (
      await tx
        .select({ id: imageStudioSettings.id, encryptedRemovebgKey: imageStudioSettings.encryptedRemovebgKey })
        .from(imageStudioSettings)
        .where(eq(imageStudioSettings.id, 1))
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

    await tx.update(imageStudioSettings).set(patch).where(eq(imageStudioSettings.id, 1));
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

// ════════════════════════════════════════════════════════════════════════════════════════════
//  مسار الذكاء الاصطناعي (استوديو موحّد بإعادة تصميم) — مستقلّ عن remove.bg، على نفس الصفّ المفرد.
// ════════════════════════════════════════════════════════════════════════════════════════════

export interface AiImageStudioSettingsDisplay {
  aiEnabled: boolean;
  hasAiKey: boolean;
  /** قناع آمن أو null — أبداً نصّاً كاملاً. */
  aiKeyMasked: string | null;
  aiProvider: string;
  /** المخزَّن (null = يستعمل الافتراضي). */
  aiModel: string | null;
  /** الفعليّ بعد حلّ الافتراضي (للعرض). */
  aiModelEffective: string;
  /** البرومت الجاهز (المخزَّن أو الافتراضي) — ليعرضه/يحرّره المالك. */
  aiStudioPrompt: string;
  aiStudioPromptIsDefault: boolean;
  aiLastVerifiedAt: Date | null;
  aiLastError: string | null;
  cryptoReady: boolean;
}

/** إعدادات عرض مسار الذكاء الاصطناعي (مُقنَّعة). */
export async function getAiImageStudioSettings(): Promise<AiImageStudioSettingsDisplay> {
  const row = await readRow();
  const key = safeDecrypt(row?.encryptedAiKey ?? null);
  const storedPrompt = row?.aiStudioPrompt?.trim() || null;
  return {
    aiEnabled: !!row?.aiEnabled,
    hasAiKey: !!key,
    aiKeyMasked: maskSecret(key),
    aiProvider: row?.aiProvider ?? "GEMINI",
    aiModel: row?.aiModel ?? null,
    aiModelEffective: row?.aiModel?.trim() || DEFAULT_GEMINI_IMAGE_MODEL,
    aiStudioPrompt: storedPrompt ?? DEFAULT_AI_STUDIO_PROMPT,
    aiStudioPromptIsDefault: !storedPrompt,
    aiLastVerifiedAt: row?.aiLastVerifiedAt ?? null,
    aiLastError: row?.aiLastError ?? null,
    cryptoReady: isCryptoReady(),
  };
}

/** إعداد عام لأي مصادَق: هل مسار الذكاء الاصطناعي متاح فعلياً (لتقرّر الواجهة العرض). لا يسرّب المفتاح. */
export async function getAiStudioConfig(): Promise<{ aiAvailable: boolean; provider: string }> {
  const row = await readRow();
  const key = safeDecrypt(row?.encryptedAiKey ?? null);
  return { aiAvailable: !!row?.aiEnabled && !!key && isCryptoReady(), provider: row?.aiProvider ?? "GEMINI" };
}

export interface AiStudioRuntime {
  apiKey: string;
  provider: string;
  model: string;
  /** البرومت الجاهز المخزَّن أو الافتراضي (يُدمَج مع إضافة المستخدم عبر buildAiStudioPrompt في الراوتر). */
  basePrompt: string;
}

/** بيانات التشغيل (المفتاح + النموذج + البرومت الجاهز) لنقطة الاستعمال (الراوتر لحظة التحويل) فقط. null لو مطفأ/غير مضبوط. */
export async function getAiStudioRuntime(): Promise<AiStudioRuntime | null> {
  const row = await readRow();
  if (!row?.aiEnabled) return null;
  const apiKey = safeDecrypt(row.encryptedAiKey);
  if (!apiKey) return null;
  return {
    apiKey,
    provider: row.aiProvider ?? "GEMINI",
    model: row.aiModel?.trim() || DEFAULT_GEMINI_IMAGE_MODEL,
    basePrompt: row.aiStudioPrompt?.trim() || DEFAULT_AI_STUDIO_PROMPT,
  };
}

export interface UpdateAiImageStudioSettingsInput {
  aiEnabled?: boolean;
  /** undefined = لا تُغيّر؛ null = امسح؛ string = مفتاح جديد. */
  aiKey?: string | null;
  /** undefined = لا تُغيّر؛ null/'' = أعِد للافتراضي؛ string = عيّن. */
  aiModel?: string | null;
  /** undefined = لا تُغيّر؛ null/'' = أعِد للبرومت الافتراضي؛ string = عيّن. */
  aiStudioPrompt?: string | null;
  aiProvider?: AiStudioProvider;
}

/** يكتب/يُحدّث إعدادات الذكاء الاصطناعي على الصفّ المفرد. بوّابة: لا تفعيل بلا مفتاح (خادمياً). */
export async function updateAiImageStudioSettings(
  input: UpdateAiImageStudioSettingsInput,
  updatedBy: number,
): Promise<void> {
  const settingKey = input.aiKey !== undefined;
  if (settingKey && input.aiKey && !isCryptoReady()) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "INTEGRATIONS_ENCRYPTION_KEY غير مضبوط في .env — أضِفه قبل حفظ مفتاح الذكاء الاصطناعي.",
    });
  }
  if (input.aiProvider !== undefined && !AI_STUDIO_PROVIDERS.includes(input.aiProvider)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "مزوّد ذكاء اصطناعي غير مدعوم." });
  }

  await withTx(async (tx) => {
    // يضمن الصفّ المفرد (id=1) ذرّيّاً (نمط taxSettings) — يمنع تسابق كاتبَي remove.bg والذكاء
    // الاصطناعي على مستأجرٍ جديد من إدراج صفّين مستقلّين يُفقِد أحدهما (readRow يقرأ الأوّل فقط).
    await tx.insert(imageStudioSettings).values({ id: 1 }).onDuplicateKeyUpdate({ set: { id: 1 } });
    const existing = (
      await tx
        .select({ id: imageStudioSettings.id, encryptedAiKey: imageStudioSettings.encryptedAiKey })
        .from(imageStudioSettings)
        .where(eq(imageStudioSettings.id, 1))
        .limit(1)
    )[0];

    const keyAfter =
      input.aiKey === undefined ? safeDecrypt(existing?.encryptedAiKey ?? null) : input.aiKey;

    if (input.aiEnabled === true && !keyAfter) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "لا يمكن تفعيل مسار الذكاء الاصطناعي بلا مفتاح. أدخِل المفتاح أولاً.",
      });
    }

    const patch: Record<string, unknown> = { updatedBy };
    if (input.aiEnabled !== undefined) patch.aiEnabled = input.aiEnabled;
    if (input.aiProvider !== undefined) patch.aiProvider = input.aiProvider;
    if (input.aiModel !== undefined) {
      patch.aiModel = input.aiModel ? input.aiModel.trim().slice(0, 80) : null;
      // تغيير النموذج ⇒ صفّر حالة الفحص (الفحص السابق قد يخصّ نموذجاً آخر، فلا يُطمأنّ إليه).
      patch.aiLastVerifiedAt = null;
      patch.aiLastError = null;
    }
    if (input.aiStudioPrompt !== undefined) {
      patch.aiStudioPrompt = input.aiStudioPrompt ? input.aiStudioPrompt.trim().slice(0, MAX_STUDIO_PROMPT_LEN) : null;
    }
    if (input.aiKey !== undefined) {
      patch.encryptedAiKey = input.aiKey ? encryptSecret(input.aiKey) : null;
      // تغيير المفتاح ⇒ صفّر حالة الفحص السابقة (يلزم فحص جديد).
      patch.aiLastVerifiedAt = null;
      patch.aiLastError = null;
      // مسح المفتاح ⇒ عطّل المسار حتماً (لا يبقى مُفعَّلاً بلا مفتاح).
      if (!input.aiKey && input.aiEnabled === undefined) patch.aiEnabled = false;
    }

    await tx.update(imageStudioSettings).set(patch).where(eq(imageStudioSettings.id, 1));
  });
}

/** يفحص مفتاح الذكاء الاصطناعي **والنموذج المُختار** فعلياً (نداء رخيص بلا توليد صورة) ويكتب النتيجة. */
export async function verifyAiConnection(): Promise<{ ok: boolean; message: string }> {
  const row = await readRow();
  const key = safeDecrypt(row?.encryptedAiKey ?? null);
  if (!key) {
    return { ok: false, message: "لا مفتاح ذكاء اصطناعي محفوظ." };
  }
  const effectiveModel = row?.aiModel?.trim() || DEFAULT_GEMINI_IMAGE_MODEL;

  let result: { ok: boolean; message: string };
  try {
    const r = await verifyGeminiKey(key);
    // لا يكفي أنّ المفتاح صالح: نتحقّق أنّ النموذج المُختار متاح فعلاً، وإلا «نجح» الفحص بينما كلّ
    // تحويلٍ لاحق يفشل بنموذجٍ غير صالح (P2 مراجعة). يتساهل عند تعذّر جلب قائمة النماذج.
    if (!isModelAvailable(effectiveModel, r.models)) {
      result = {
        ok: false,
        message: `المفتاح صالح لكنّ النموذج «${effectiveModel}» غير متاح لهذا المفتاح — تحقّق من اسم النموذج في الإعدادات.`,
      };
    } else {
      const parts: string[] = [`المفتاح والنموذج «${effectiveModel}» صالحان.`];
      if (r.modelCount != null) parts.push(`نماذج متاحة: ${r.modelCount}`);
      result = { ok: true, message: parts.join(" ") };
    }
  } catch (e) {
    const msg = e instanceof AiImageError ? aiImageErrorMessageAr(e.kind) : "فشل الفحص.";
    result = { ok: false, message: msg };
  }

  await withTx(async (tx) => {
    const existing = (
      await tx.select({ id: imageStudioSettings.id }).from(imageStudioSettings).orderBy(imageStudioSettings.id).limit(1)
    )[0];
    if (existing) {
      await tx
        .update(imageStudioSettings)
        .set({
          aiLastVerifiedAt: result.ok ? new Date() : null,
          aiLastError: result.ok ? null : result.message.slice(0, 500),
        })
        .where(eq(imageStudioSettings.id, existing.id));
    }
  });

  return result;
}
