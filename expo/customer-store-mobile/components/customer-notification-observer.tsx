import { useEffect } from "react";
import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";
import { Platform } from "react-native";

import { storefrontPathFromNotificationData } from "@/lib/customer-notification-routes";
import { trackStorefrontPushInteraction } from "@/lib/storefront-api";

export function CustomerNotificationObserver() {
  const router = useRouter();

  useEffect(() => {
    if (Platform.OS === "web") return;
    const openDestination = (response: Notifications.NotificationResponse) => {
      const data = response.notification.request.content.data;
      const path = storefrontPathFromNotificationData(data);
      if (path) router.push(path as never);
      const deliveryId = typeof data?.deliveryId === "number" ? data.deliveryId : Number(data?.deliveryId);
      if (Number.isInteger(deliveryId) && deliveryId > 0) void trackStorefrontPushInteraction(deliveryId, "OPEN").catch(() => undefined);
    };

    const previous = Notifications.getLastNotificationResponse();
    if (previous) openDestination(previous);

    const subscription = Notifications.addNotificationResponseReceivedListener(openDestination);
    return () => subscription.remove();
  }, [router]);

  return null;
}
