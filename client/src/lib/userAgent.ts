// وصف مبسّط لسلسلة User-Agent لعرضها في شاشة «الجلسات النشطة» — تخمين تقريبي (لا مكتبة
// تحليل خارجية) يكفي لتمييز «متصفح على نظام» بصرياً، لا لأي قرار أمني.

function detectBrowser(ua: string): string {
  if (/edg\//i.test(ua)) return "Edge";
  if (/opr\/|opera/i.test(ua)) return "Opera";
  if (/chrome\//i.test(ua) && !/chromium/i.test(ua)) return "Chrome";
  if (/firefox\//i.test(ua)) return "Firefox";
  if (/safari\//i.test(ua) && !/chrome\//i.test(ua)) return "Safari";
  return "متصفح";
}

function detectOs(ua: string): string {
  if (/windows/i.test(ua)) return "Windows";
  if (/android/i.test(ua)) return "Android";
  if (/iphone|ipad|ios/i.test(ua)) return "iOS";
  if (/mac os x|macintosh/i.test(ua)) return "macOS";
  if (/linux/i.test(ua)) return "Linux";
  return "جهاز غير معروف";
}

/** «Chrome على Windows» من سلسلة User-Agent خام، أو «جهاز غير معروف» إن غابت. */
export function describeUserAgent(ua: string | null | undefined): string {
  if (!ua) return "جهاز غير معروف";
  return `${detectBrowser(ua)} على ${detectOs(ua)}`;
}
