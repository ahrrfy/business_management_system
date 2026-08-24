/**
 * روابط الوثائق القانونيّة العامّة على `alarabiya.online`.
 *
 * ⚠️ P2 مراجعة Codex: هذه المسارات يجب أن تُنشَر على ERP الأمّ قبل أن تُصبح
 * الأزرار الرابطة فعّالة. حالياً موجودة مسوّداتٌ محلّيّة فقط في
 * `expo/customer-store-mobile/docs/*-draft.md`، ولا يوجد handler ERP يُقدّمها.
 * `Linking.canOpenURL()` يعيد `true` لأيّ https صحيح بنيويّاً ⇒ لا يمكنه اكتشاف
 * أنّ العنوان يُقدّم HTML SPA fallback بدل صفحة قانونيّة حقيقيّة.
 *
 * **قرارُ التسمية**: نستعمل `/legal/*` (لا `/privacy`، `/terms`، `/returns`) لأنّ:
 *   - `/returns` مستعملٌ في ERP كمسار مبيعات مرتجَع مصادَق (إن فُتح للعامّة يُعيد صفحة SPA
 *     تطلب تسجيل الدخول — تجربة مضلّلة للعميل).
 *   - `/legal/*` بادئةٌ غير مأخوذة، ومُعبّرة بوضوح عن طبيعة الصفحات.
 *
 * **قبل إنجاز ERP handlers**: هذه الأزرار تعرض للعميل صفحةً غير متوقّعة (SPA fallback).
 * حتى يُنشَر المسار على ERP، خيار المالك:
 *   ١) إبقاء الأزرار موصولة (تعليقُ Play/App Store قد يحدث إن راجع المفتّش صفحةً غير قانونيّة)
 *   ٢) تعطيلها مؤقّتاً بتصدير `LEGAL_ENABLED = false` من هنا وحجب الأزرار حتى ينتهي النشر
 *
 * راجع docs/erp-followups.md § F-٤ (سيُضاف: publish legal pages).
 */

import { Linking } from "react-native";

export const LEGAL_URLS = {
  privacy: "https://alarabiya.online/legal/privacy",
  terms: "https://alarabiya.online/legal/terms",
  returns: "https://alarabiya.online/legal/returns",
} as const;

export type LegalPage = keyof typeof LEGAL_URLS;

/**
 * علَمُ تفعيل الروابط. يُضبَط `true` بعد نشر handlers `/legal/*` على ERP والتحقّق
 * أنّها تُقدّم المحتوى الصحيح فعلياً — لا SPA fallback ولا مسار ERP آخر.
 * الأزرار في الشاشات ترصده وتُخفي نفسها حين false (سلوك أفضل من فتح متصفّح على SPA).
 */
export const LEGAL_ENABLED = false;

/** يفتح صفحةً قانونيّة في متصفّح النظام. لا يُخفق: إن رفض Linking، يُطلَع المستدعي على الفشل. */
export async function openLegalPage(page: LegalPage): Promise<boolean> {
  if (!LEGAL_ENABLED) return false;
  const url = LEGAL_URLS[page];
  try {
    const canOpen = await Linking.canOpenURL(url);
    if (!canOpen) return false;
    await Linking.openURL(url);
    return true;
  } catch {
    return false;
  }
}
