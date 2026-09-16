import { useEffect } from "react";
import { useRouter } from "expo-router";

import { observeSecureSuperAppNotificationResponses } from "@/lib/pushNotifications";

/** Opens only a reviewed internal tab after the OS gives us a notification response. */
export function SecureNotificationResponseHandler() {
  const router = useRouter();
  useEffect(() => observeSecureSuperAppNotificationResponses((href) => {
    if (href) router.replace(href);
  }), [router]);
  return null;
}
