import { useEffect, useRef, useState } from "react";
import {
  REALTIME_EVENT_TYPES,
  type RealtimeEvent,
  type RealtimeEventType,
  type RealtimeEventScope,
  type CustomerFacingDisplayUpdatedPayload,
} from "@shared/realtimeEvents";
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

/**
 * بث حدث محلي عبر BroadcastChannel لكافة التبويبات المفتوحة على هذا الجهاز
 */
export function broadcastRealtimeEvent<T = unknown>(
  type: RealtimeEventType,
  payload: T,
  scope?: RealtimeEventScope,
): RealtimeEvent<T> {
  return realtimeManager.broadcastLocalEvent(type, payload, scope);
}

/**
 * بث تحديثات شاشة العميل المقابلة (Customer Facing Display - CFD) عبر BroadcastChannel
 */
export function broadcastCustomerFacingDisplay(payload: CustomerFacingDisplayUpdatedPayload): void {
  broadcastRealtimeEvent(
    REALTIME_EVENT_TYPES.CUSTOMER_FACING_DISPLAY_UPDATED,
    payload,
    { branchId: payload.branchId },
  );
}

/**
 * خطاف للاستماع لتحديثات شاشة العميل المقابلة (CFD) في شاشة العرض
 */
export function useCustomerFacingDisplay(
  onUpdate: (payload: CustomerFacingDisplayUpdatedPayload) => void,
): void {
  useRealtimeEvent<CustomerFacingDisplayUpdatedPayload>(
    REALTIME_EVENT_TYPES.CUSTOMER_FACING_DISPLAY_UPDATED,
    (event) => {
      onUpdate(event.payload);
    },
  );
}

