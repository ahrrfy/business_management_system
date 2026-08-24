/**
 * روابط الوثائق القانونيّة العامّة على `alarabiya.online`.
 * تنشر عبر ERP الرئيسيّ (راجع docs/privacy-policy-draft.md وأخواتها) بعد اعتمادها قانونياً.
 * حين تُنشَر، هذه الروابط تُفتح في متصفّح النظام (Safari/Chrome) لا داخل التطبيق.
 */

import { Linking } from "react-native";

export const LEGAL_URLS = {
  privacy: "https://alarabiya.online/privacy",
  terms: "https://alarabiya.online/terms",
  returns: "https://alarabiya.online/returns",
} as const;

export type LegalPage = keyof typeof LEGAL_URLS;

/** يفتح صفحةً قانونيّة في متصفّح النظام. لا يُخفق: إن رفض Linking، يُطلَع المستدعي على الفشل. */
export async function openLegalPage(page: LegalPage): Promise<boolean> {
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
