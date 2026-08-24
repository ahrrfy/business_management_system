import { Redirect, useLocalSearchParams } from "expo-router";

// المُولِّد الخادميّ يستعمل randomBytes(18).toString("base64url") = ٢٤ محرفاً بالضبط.
// يُرفض أيّ token خارج هذا الشكل قبل ملامسة المتجر لتفادي محاولات التخمين/الحشو.
const WISHLIST_SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{24}$/;

/** يترجم Android App Link العام إلى مسار الشاشة الداخلية دون تكرار شاشة القراءة. */
export default function SharedWishlistAppLink() {
  const params = useLocalSearchParams<{ token?: string | string[] }>();
  const rawToken = Array.isArray(params.token) ? params.token[0] : params.token;
  const token = rawToken && WISHLIST_SHARE_TOKEN_PATTERN.test(rawToken) ? rawToken : null;
  return <Redirect href={token ? (`/shared-wishlist/${token}` as never) : ("/" as never)} />;
}
