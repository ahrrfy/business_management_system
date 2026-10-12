/**
 * عقد الأحداث اللحظية (Real-Time Events Contract) — المصدر الموحّد بين الخادم والعميل.
 *
 * وفق المخطط المعماري والاستشاري (Wave 0):
 * - ناقل الأحداث يعتمد Server-Sent Events (SSE) في الاتجاه خادم->عميل.
 * - تنسيق التبويبات المتعددة عبر BroadcastChannel على نفس الجهاز.
 * - عزل الفروع الصارم (scopedBranchId) لمنع تسريب الأحداث بين الفروع.
 * - نبضات الحفاظ على الاتصال (ping) كل 15 ثانية لمقاومة جدران CGNAT العراقية ومهلة Nginx (120s).
 * - فصل الاتصال التلقائي عند الخمول لأكثر من 15 دقيقة (document.visibilityState === 'hidden').
 */

export const REALTIME_BROADCAST_CHANNEL = "alroya_realtime_bus";
export const REALTIME_BRIDGE_PORT = 3009;
export const REALTIME_BRIDGE_HOST = "127.0.0.1";
export const REALTIME_HEARTBEAT_INTERVAL_MS = 15_000; // 15 ثانية
export const REALTIME_IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 دقيقة خمول

/**
 * الأنواع المعيارية لأحداث النظام اللحظية عبر كافة الموجات.
 */
export const REALTIME_EVENT_TYPES = {
  // الموجة ٠ (Wave 0): اتصالات البنية التحتية
  CONNECTED: "CONNECTED",
  RESYNC_REQUIRED: "RESYNC_REQUIRED",
  PING: "PING",

  // الموجة ١ (Wave 1): الإشعارات والاعتمادات
  NOTIFICATION_INSERTED: "NOTIFICATION_INSERTED",
  PENDING_APPROVAL_CREATED: "PENDING_APPROVAL_CREATED",
  APPROVAL_RESOLVED: "APPROVAL_RESOLVED",
  ANNOUNCEMENT_PUBLISHED: "ANNOUNCEMENT_PUBLISHED",

  // الموجة ٢ (Wave 2): خط إنتاج المطبعة والاستقبال
  WORK_ORDER_CREATED: "WORK_ORDER_CREATED",
  WORK_ORDER_STATUS_CHANGED: "WORK_ORDER_STATUS_CHANGED",
  WORK_ORDER_CLAIMED: "WORK_ORDER_CLAIMED",
  RECEPTION_QUEUE_UPDATED: "RECEPTION_QUEUE_UPDATED",

  // الموجة ٣ (Wave 3): أسطول التوصيل ومتجر الطلبات
  STOREFRONT_ORDER_PLACED: "STOREFRONT_ORDER_PLACED",
  DELIVERY_DISPATCHED: "DELIVERY_DISPATCHED",
  DELIVERY_COMPLETED: "DELIVERY_COMPLETED",
  SHORTFALL_ASSIGNED: "SHORTFALL_ASSIGNED",

  // الموجة ٤ (Wave 4): العمليات الميدانية والجرد والسلال
  STOCKTAKE_PROGRESS: "STOCKTAKE_PROGRESS",
  HELD_ORDER_UPDATED: "HELD_ORDER_UPDATED",
  CUSTOMER_FACING_DISPLAY_UPDATED: "CUSTOMER_FACING_DISPLAY_UPDATED",
  INVENTORY_DEPLETED: "INVENTORY_DEPLETED",

  // الموجة ٥ (Wave 5): المزامنة المجمعة
  BATCH_SALES_SYNCED: "BATCH_SALES_SYNCED",
  FINANCIAL_DATA_CHANGED: "FINANCIAL_DATA_CHANGED",
} as const;

export type RealtimeEventType =
  (typeof REALTIME_EVENT_TYPES)[keyof typeof REALTIME_EVENT_TYPES] | (string & {});

/**
 * نطاق توجيه الحدث (Targeting Scope) لعزل الفروع والمستخدمين.
 */
export interface RealtimeEventScope {
  /** إن حُدد، يُبث الحدث فقط للعملاء المرتبطين بهذه الشركة (Multi-tenancy). */
  companyId?: number | null;
  /** إن حُدد، يُبث الحدث فقط للعملاء المرتبطين بهذا الفرع. null أو undefined تعني كل الفروع. */
  branchId?: number | null;
  /** إن حُدد، يُبث الحدث فقط لهذا المستخدم المحدد. */
  userId?: number | null;
  /** إن حُدد، يُبث الحدث فقط لأصحاب هذا الدور (مثل "admin" أو "cashier"). */
  role?: string | null;
  /** معرّف الاتصال المستثنى من الاستلام (لمنع ارتداد الحدث لنفس المتصل). */
  excludeConnectionId?: string | null;
}

/**
 * بنية الحدث اللحظي المعياري المنقول عبر SSE وناقل الحلقات.
 */
export interface RealtimeEvent<T = unknown> {
  id: string;
  type: RealtimeEventType;
  payload: T;
  timestamp: number;
  scope?: RealtimeEventScope;
}

let counter = 0;
/**
 * توليد معرّف حدث فريد وخفيف خادمي/عميل.
 */
export function generateEventId(): string {
  counter = (counter + 1) % 1000000;
  return `rt_${Date.now()}_${counter}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * إنشاء كائن حدث لحظي مستوفٍ للعقد.
 */
export function createRealtimeEvent<T = unknown>(
  type: RealtimeEventType,
  payload: T,
  scope?: RealtimeEventScope,
): RealtimeEvent<T> {
  return {
    id: generateEventId(),
    type,
    payload,
    timestamp: Date.now(),
    scope,
  };
}

/**
 * حمولة حدث إدراج إشعار لمستخدم (NOTIFICATION_INSERTED)
 */
export interface NotificationInsertedPayload {
  userId: number;
  kind: string;
  family?: string;
  title: string;
  body: string;
  route?: string;
  entityType?: string | null;
  entityId?: number | null;
}

/**
 * حمولة حدث إنشاء طلب اعتماد جديد (PENDING_APPROVAL_CREATED)
 */
export interface PendingApprovalCreatedPayload {
  entityType: string;
  entityId: number;
  direction?: string;
  amount?: string;
  voucherNumber?: string | null;
  requestType?: string;
  invoiceId?: number;
  branchId?: number | null;
  reason?: string | null;
}

/**
 * حمولة حدث حسم طلب اعتماد (APPROVAL_RESOLVED)
 */
export interface ApprovalResolvedPayload {
  entityType?: string;
  entityId?: number;
  decision?: string;
  outcome?: string;
  action?: string;
  direction?: string;
  amount?: string;
  voucherNumber?: string | null;
  actorUserId?: number;
  managerId?: number;
  managerName?: string;
  branchId?: number | null;
  reason?: string | null;
}

/**
 * حمولة حدث نشر إعلان إداري (ANNOUNCEMENT_PUBLISHED)
 */
export interface AnnouncementPublishedPayload {
  id: number;
  title: string;
  body: string;
  priority: "NORMAL" | "IMPORTANT" | "CRITICAL";
  audienceType: string;
  audienceBranchId?: number | null;
  audienceRole?: string | null;
  requiresAck?: boolean;
  createdBy: number;
}

/**
 * حمولة حدث إنشاء أمر شغل جديد (WORK_ORDER_CREATED)
 */
export interface WorkOrderCreatedPayload {
  workOrderId: number;
  orderNumber: string;
  branchId: number;
  title?: string;
  status: string;
  customerName?: string;
}

/**
 * حمولة حدث تغيّر حالة أمر الشغل (WORK_ORDER_STATUS_CHANGED)
 */
export interface WorkOrderStatusChangedPayload {
  workOrderId: number;
  orderNumber?: string;
  branchId: number;
  previousStatus?: string;
  newStatus: string;
  updatedBy?: number;
}

/**
 * حمولة حدث سحب / حجز أمر الشغل في المحطة (WORK_ORDER_CLAIMED)
 */
export interface WorkOrderClaimedPayload {
  workOrderId: number;
  branchId: number;
  claimedByUserId: number | null;
  claimedByUserName?: string;
}

/**
 * حمولة حدث تحديث طابور الاستقبال وجاهزية التسليم (RECEPTION_QUEUE_UPDATED)
 */
export interface ReceptionQueueUpdatedPayload {
  orderId: number;
  orderNumber?: string;
  branchId: number;
  status: string;
  customerName?: string;
  readyForPickup?: boolean;
}

/**
 * حمولة حدث وضع طلب شراء من المتجر الإلكتروني (STOREFRONT_ORDER_PLACED)
 */
export interface StorefrontOrderPlacedPayload {
  orderId: number;
  orderNumber: string;
  branchId: number;
  totalAmount: string;
  customerName?: string;
  itemsCount?: number;
}

/**
 * حمولة حدث إرسال شحنة إلى السائق (DELIVERY_DISPATCHED)
 */
export interface DeliveryDispatchedPayload {
  deliveryId: number;
  invoiceId?: number;
  orderId?: number;
  trackingNumber?: string;
  driverId: number;
  branchId: number;
}

/**
 * حمولة حدث اكتمال تسليم شحنة (DELIVERY_COMPLETED)
 */
export interface DeliveryCompletedPayload {
  deliveryId: number;
  invoiceId?: number;
  driverId: number;
  branchId: number;
  collectedAmount?: string;
}

/**
 * حمولة حدث تسجيل نقص عهدة سائق (SHORTFALL_ASSIGNED)
 */
export interface ShortfallAssignedPayload {
  deliveryId?: number;
  driverId: number;
  amount: string;
  reason?: string;
  branchId: number;
}

/**
 * حمولة حدث تقدم الجرد الميداني (STOCKTAKE_PROGRESS)
 */
export interface StocktakeProgressPayload {
  sessionId: number;
  branchId: number;
  totalScanned: number;
  lastItemSku?: string;
  counterUserId?: number;
  timestamp: number;
}

/**
 * حمولة حدث تعديل/قفل سلة معلقة (HELD_ORDER_UPDATED)
 */
export interface HeldOrderUpdatedPayload {
  heldOrderId: number;
  branchId: number;
  action: "HELD" | "LOCKED" | "RELEASED" | "RESUMED" | "DISCARDED";
  lockedByUserId?: number | null;
}

/**
 * حمولة حدث تحديث شاشة العميل (CUSTOMER_FACING_DISPLAY_UPDATED)
 */
export interface CustomerFacingDisplayUpdatedPayload {
  terminalId: string;
  branchId: number;
  lines: Array<{ name: string; quantity: number; price: string }>;
  total: string;
  discount?: string;
  changeDue?: string;
  customerName?: string;
}

/**
 * حمولة حدث نفاد كمية صنف في المخزون (INVENTORY_DEPLETED)
 */
export interface InventoryDepletedPayload {
  productId: number;
  branchId: number;
  sku?: string;
  productName?: string;
  remainingStock: number;
}

/**
 * حمولة حدث مزامنة مبيعات أوفلاين مجمعة (BATCH_SALES_SYNCED)
 */
export interface BatchSalesSyncedPayload {
  branchId: number;
  deviceId?: string;
  syncedCount: number;
  totalAmount: string;
  timestamp: number;
}

