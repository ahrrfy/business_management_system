import { useEffect, useRef, useState } from "react";
import type { RealtimeEvent, RealtimeEventType } from "@shared/realtimeEvents";
import {
  realtimeManager,
  type RealtimeConnectionStatus,
} from "./realtimeManager";

export { realtimeManager, type RealtimeConnectionStatus };

/**
 * تهيئة مدير اللحظية للنظام بأكمله. تُستدعى مرة واحدة في دورة حياة التطبيق (مثال: main.tsx).
 */
export function initRealtime(): void {
  if (typeof window !== "undefined") {
    realtimeManager.start();
  }
}

/**
 * خطاف (Hook) للاشتراك في حدث لحظي محدد، أو قائمة أحداث، أو كافة الأحداث.
 */
export function useRealtimeEvent<T = unknown>(
  eventType: RealtimeEventType | readonly RealtimeEventType[] | "*",
  handler: (event: RealtimeEvent<T>) => void,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  const eventKey = Array.isArray(eventType) ? eventType.join(",") : eventType;

  useEffect(() => {
    const callback = (event: RealtimeEvent<T>) => {
      handlerRef.current(event);
    };

    if (Array.isArray(eventType)) {
      const unsubscribers = eventType.map((type) =>
        realtimeManager.subscribe<T>(type, callback),
      );
      return () => {
        for (const unsub of unsubscribers) unsub();
      };
    }
    return realtimeManager.subscribe<T>(eventType as RealtimeEventType | "*", callback);
  }, [eventKey]);
}

/**
 * خطاف لمتابعة حالة اتصال قناة اللحظية في الواجهة.
 */
export function useRealtimeStatus(): RealtimeConnectionStatus {
  const [status, setStatus] = useState<RealtimeConnectionStatus>(() =>
    realtimeManager.getStatus(),
  );

  useEffect(() => {
    return realtimeManager.subscribeStatus(setStatus);
  }, []);

  return status;
}

/**
 * إشعار مدير اللحظية بتغيّر حالة تطبيق الهاتف المحمول (active / background / inactive)
 */
export function setRealtimeAppState(state: "active" | "background" | "inactive"): void {
  realtimeManager.setAppState(state);
}
