import { Redirect, useLocalSearchParams } from "expo-router";

/** يترجم Android App Link العام إلى مسار الشاشة الداخلية دون تكرار شاشة القراءة. */
export default function SharedWishlistAppLink() {
  const params = useLocalSearchParams<{ token?: string | string[] }>();
  const token = Array.isArray(params.token) ? params.token[0] : params.token;
  return <Redirect href={token ? (`/shared-wishlist/${token}` as never) : ("/" as never)} />;
}
