import {
  type RealtimeEventType,
  type RealtimeEventScope,
  type RealtimeEvent,
  createRealtimeEvent,
} from "@shared/realtimeEvents";
import {
  initRealtimeBridge,
  publishToBridge,
  onBridgeEvent,
  stopRealtimeBridge,
  getBridgeStatus,
} from "./bridge";
import { sseManager } from "./sseManager";
import { realtimeRouter } from "./streamRouter";

import { getCurrentCompanyId } from "../tenancy/context";

// ربط الناقل الحلقي بمدير تدفق الـ SSE:
// أي حدث يرد عبر الناقل (محلياً أو قادماً من عامل PM2 آخر) يُبث فوراً لكافة اتصالات SSE المؤهلة على هذا العامل.
onBridgeEvent((event: RealtimeEvent) => {
  sseManager.broadcast(event);
});

/**
 * دالة النشر الموحدة للأحداث اللحظية من كافة خدمات وخوادم النظام:
 * - تنشئ كائن الحدث مستوفياً للعقد والمعرّف والوقت.
 * - تنشره عبر الناقل الحلقي (Loopback Bridge) لتوزيعه على كافة عمال PM2.
 * - تعزل الشركة تلقائياً وفق سياق المستأجر (Company Isolation).
 * - يعيد كائن الحدث المنشور.
 */
export function publishRealtimeEvent<T = unknown>(
  type: RealtimeEventType,
  payload: T,
  scope?: RealtimeEventScope,
): RealtimeEvent<T> {
  const currentCompany = getCurrentCompanyId();
  const mergedScope: RealtimeEventScope = {
    ...(currentCompany != null && scope?.companyId === undefined
      ? { companyId: currentCompany }
      : {}),
    ...scope,
  };
  const event = createRealtimeEvent(type, payload, mergedScope);
  publishToBridge(event);
  return event;
}

export {
  initRealtimeBridge,
  stopRealtimeBridge,
  getBridgeStatus,
  sseManager,
  realtimeRouter,
};
