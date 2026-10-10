import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  REALTIME_EVENT_TYPES,
  type NotificationInsertedPayload,
  type PendingApprovalCreatedPayload,
  type ApprovalResolvedPayload,
  type AnnouncementPublishedPayload,
  type RealtimeEvent,
} from "@shared/realtimeEvents";
import {
  publishRealtimeEvent,
  initRealtimeBridge,
  stopRealtimeBridge,
  sseManager,
} from "../index";
import { onBridgeEvent } from "../bridge";

function createMockReqRes() {
  const req = new EventEmitter() as any;
  req.headers = {};
  const res = new EventEmitter() as any;
  res.writtenData = [] as string[];
  res.writableEnded = false;
  res.destroyed = false;
  res.write = vi.fn((data: string) => {
    res.writtenData.push(data);
    return true;
  });
  res.end = vi.fn(() => {
    res.writableEnded = true;
  });
  return { req, res };
}

describe("Wave 1 Real-Time Events — دورة الأحداث اللحظية للإشعارات والاعتمادات والإعلانات", () => {
  beforeEach(async () => {
    await initRealtimeBridge({ inMemoryOnly: true });
    sseManager.closeAll();
  });

  afterEach(async () => {
    await stopRealtimeBridge();
    sseManager.closeAll();
  });

  describe("عقود وتوليد الأحداث (Payload Contracts & Event Creation)", () => {
    it("يولد حدث NOTIFICATION_INSERTED مع المعرف والنطاق والوقت الزمني", () => {
      const payload: NotificationInsertedPayload = {
        userId: 42,
        kind: "APPROVAL_REQUIRED",
        family: "APPROVAL",
        title: "اعتماد صرف #V-102 بانتظارك",
        body: "سند صرف بمبلغ 150,000 د.ع — بانتظار اعتماد مالك.",
        route: "/my-work",
        entityType: "receipt",
        entityId: 102,
      };

      const event = publishRealtimeEvent(
        REALTIME_EVENT_TYPES.NOTIFICATION_INSERTED,
        payload,
        { userId: 42 },
      );

      expect(event.id).toMatch(/^rt_\d+_/);
      expect(event.type).toBe(REALTIME_EVENT_TYPES.NOTIFICATION_INSERTED);
      expect(event.payload).toEqual(payload);
      expect(event.scope?.userId).toBe(42);
      expect(typeof event.timestamp).toBe("number");
      expect(event.timestamp).toBeGreaterThan(0);
    });

    it("يولد حدث PENDING_APPROVAL_CREATED لطلبات الاعتماد واستثناءات الخصم", () => {
      const payload: PendingApprovalCreatedPayload = {
        entityType: "sales_control_request",
        entityId: 555,
        requestType: "SALES_DISCOUNT_OVERRIDE",
        invoiceId: 987,
        branchId: 2,
        reason: "خصم ترويجي خاص للزبون تجاوز 15%",
      };

      const event = publishRealtimeEvent(
        REALTIME_EVENT_TYPES.PENDING_APPROVAL_CREATED,
        payload,
        { branchId: 2 },
      );

      expect(event.type).toBe(REALTIME_EVENT_TYPES.PENDING_APPROVAL_CREATED);
      expect(event.payload.entityType).toBe("sales_control_request");
      expect(event.payload.entityId).toBe(555);
      expect(event.payload.branchId).toBe(2);
      expect(event.scope?.branchId).toBe(2);
    });

    it("يولد حدث APPROVAL_RESOLVED لفك حظر الكاشير وتحديث شارات القرار", () => {
      const payload: ApprovalResolvedPayload = {
        entityType: "pos_manager_verification",
        decision: "APPROVED",
        outcome: "APPROVED",
        action: "APPROVE",
        managerId: 7,
        managerName: "علي المدير",
        branchId: 1,
        actorUserId: 7,
        reason: "تمت الموافقة بالباركود",
      };

      const event = publishRealtimeEvent(
        REALTIME_EVENT_TYPES.APPROVAL_RESOLVED,
        payload,
        { branchId: 1 },
      );

      expect(event.type).toBe(REALTIME_EVENT_TYPES.APPROVAL_RESOLVED);
      expect(event.payload.decision).toBe("APPROVED");
      expect(event.payload.managerName).toBe("علي المدير");
      expect(event.scope?.branchId).toBe(1);
    });

    it("يولد حدث ANNOUNCEMENT_PUBLISHED للإعلانات الإدارية والعاجلة", () => {
      const payload: AnnouncementPublishedPayload = {
        id: 88,
        title: "تنبيه جرد نهاية الشهر",
        body: "يرجى من مسؤولي الفروع إيقاف حركات الصرف قبل الساعة 6 مساءً",
        priority: "CRITICAL",
        audienceType: "BRANCH",
        audienceBranchId: 3,
        audienceRole: null,
        requiresAck: true,
        createdBy: 1,
      };

      const event = publishRealtimeEvent(
        REALTIME_EVENT_TYPES.ANNOUNCEMENT_PUBLISHED,
        payload,
        { branchId: 3 },
      );

      expect(event.type).toBe(REALTIME_EVENT_TYPES.ANNOUNCEMENT_PUBLISHED);
      expect(event.payload.priority).toBe("CRITICAL");
      expect(event.payload.requiresAck).toBe(true);
      expect(event.scope?.branchId).toBe(3);
    });
  });

  describe("بث الأحداث وتوجيهها وعزل الفروع (SSE Scoping & Isolation)", () => {
    it("يوجه إشعار المستخدم الخاص إليه فقط دون باقي المستخدمين", () => {
      const client1 = createMockReqRes();
      const client2 = createMockReqRes();

      sseManager.registerClient({
        id: "conn_user_1",
        userId: 101,
        role: "cashier",
        scopedBranchId: 1,
        companyId: 1,
        req: client1.req,
        res: client1.res,
      });

      sseManager.registerClient({
        id: "conn_user_2",
        userId: 102,
        role: "cashier",
        scopedBranchId: 1,
        companyId: 1,
        req: client2.req,
        res: client2.res,
      });

      publishRealtimeEvent(
        REALTIME_EVENT_TYPES.NOTIFICATION_INSERTED,
        {
          userId: 101,
          kind: "TASK_ASSIGNED",
          title: "مهمة جديدة لك",
          body: "يرجى مراجعة الطلب",
        },
        { userId: 101 },
      );

      // يجب أن يستلم المستخدم 101 الحدث
      expect(client1.res.writtenData.length).toBe(1);
      expect(client1.res.writtenData[0]).toContain(REALTIME_EVENT_TYPES.NOTIFICATION_INSERTED);
      expect(client1.res.writtenData[0]).toContain("مهمة جديدة لك");

      // يجب ألا يستلم المستخدم 102 الحدث الخاص بالمستخدم 101
      expect(client2.res.writtenData.length).toBe(0);
    });

    it("يعزل أحداث الفروع ويمنع تسرب أحداث فرع لآخر (Branch Isolation)", () => {
      const clientB1 = createMockReqRes();
      const clientB2 = createMockReqRes();

      sseManager.registerClient({
        id: "conn_b1",
        userId: 201,
        role: "cashier",
        scopedBranchId: 1,
        companyId: 1,
        req: clientB1.req,
        res: clientB1.res,
      });

      sseManager.registerClient({
        id: "conn_b2",
        userId: 202,
        role: "cashier",
        scopedBranchId: 2,
        companyId: 1,
        req: clientB2.req,
        res: clientB2.res,
      });

      // بث حدث خاص بالفرع 1 (طلب اعتماد خصم في كاشير الفرع 1)
      publishRealtimeEvent(
        REALTIME_EVENT_TYPES.APPROVAL_RESOLVED,
        {
          entityType: "pos_manager_verification",
          decision: "APPROVED",
          managerName: "مدير الفرع 1",
          branchId: 1,
        },
        { branchId: 1 },
      );

      expect(clientB1.res.writtenData.length).toBe(1);
      expect(clientB1.res.writtenData[0]).toContain("مدير الفرع 1");
      expect(clientB2.res.writtenData.length).toBe(0);
    });

    it("يبث الإعلانات العامة لكافة الفروع والمستخدمين في نفس الشركة", () => {
      const clientU1 = createMockReqRes();
      const clientU2 = createMockReqRes();

      sseManager.registerClient({
        id: "conn_u1",
        userId: 301,
        role: "employee",
        scopedBranchId: 1,
        companyId: 1,
        req: clientU1.req,
        res: clientU1.res,
      });

      sseManager.registerClient({
        id: "conn_u2",
        userId: 302,
        role: "employee",
        scopedBranchId: 2,
        companyId: 1,
        req: clientU2.req,
        res: clientU2.res,
      });

      // بث إعلان عام للشركة (دون تحديد فرع)
      publishRealtimeEvent(
        REALTIME_EVENT_TYPES.ANNOUNCEMENT_PUBLISHED,
        {
          id: 999,
          title: "تحديث النظام العام",
          body: "تم تحديث النظام إلى الإصدار الأخير",
          priority: "NORMAL",
          audienceType: "ALL",
          createdBy: 1,
        },
      );

      expect(clientU1.res.writtenData.length).toBe(1);
      expect(clientU1.res.writtenData[0]).toContain("تحديث النظام العام");

      expect(clientU2.res.writtenData.length).toBe(1);
      expect(clientU2.res.writtenData[0]).toContain("تحديث النظام العام");
    });

    it("يوجه إعلانات المستخدم المباشر (Direct User Announcement) للمستخدم المحدد فقط عبر نطاق userId", () => {
      const clientU42 = createMockReqRes();
      const clientU43 = createMockReqRes();

      sseManager.registerClient({
        id: "conn_u42",
        userId: 42,
        role: "cashier",
        scopedBranchId: 1,
        companyId: 1,
        req: clientU42.req,
        res: clientU42.res,
      });

      sseManager.registerClient({
        id: "conn_u43",
        userId: 43,
        role: "cashier",
        scopedBranchId: 1,
        companyId: 1,
        req: clientU43.req,
        res: clientU43.res,
      });

      // بث إعلان موجه مباشرة للمستخدم 42
      publishRealtimeEvent(
        REALTIME_EVENT_TYPES.ANNOUNCEMENT_PUBLISHED,
        {
          id: 501,
          title: "إشعار إداري خاص بك",
          body: "يرجى مراجعة الإدارة",
          priority: "IMPORTANT",
          audienceType: "ROLE",
          audienceRole: "user:42",
          createdBy: 1,
        },
        { userId: 42 },
      );

      expect(clientU42.res.writtenData.length).toBe(1);
      expect(clientU42.res.writtenData[0]).toContain("إشعار إداري خاص بك");

      expect(clientU43.res.writtenData.length).toBe(0);
    });

    it("يبث حسم طلب التحكم بالمبيعات APPROVAL_RESOLVED لكاشير الفرع المعني دون الفروع الأخرى", () => {
      const clientCashierB1 = createMockReqRes();
      const clientCashierB2 = createMockReqRes();

      sseManager.registerClient({
        id: "conn_pos_b1",
        userId: 111,
        role: "cashier",
        scopedBranchId: 1,
        companyId: 1,
        req: clientCashierB1.req,
        res: clientCashierB1.res,
      });

      sseManager.registerClient({
        id: "conn_pos_b2",
        userId: 222,
        role: "cashier",
        scopedBranchId: 2,
        companyId: 1,
        req: clientCashierB2.req,
        res: clientCashierB2.res,
      });

      publishRealtimeEvent(
        REALTIME_EVENT_TYPES.APPROVAL_RESOLVED,
        {
          entityType: "sales_control_request",
          entityId: 88,
          decision: "APPROVED",
          outcome: "APPROVED",
          action: "APPROVE",
          managerId: 5,
          managerName: "مدير الفرع",
          branchId: 1,
          actorUserId: 111,
        },
        { branchId: 1 },
      );

      expect(clientCashierB1.res.writtenData.length).toBe(1);
      expect(clientCashierB1.res.writtenData[0]).toContain("sales_control_request");
      expect(clientCashierB1.res.writtenData[0]).toContain("APPROVED");

      expect(clientCashierB2.res.writtenData.length).toBe(0);
    });

    it("يميز أحداث اعتمادات السندات والإيصالات (receipt) بنوع الكيان entityType لمنع التداخل مع نقاط البيع", () => {
      const event = publishRealtimeEvent(
        REALTIME_EVENT_TYPES.APPROVAL_RESOLVED,
        {
          entityType: "receipt",
          entityId: 777,
          decision: "APPROVED",
          voucherNumber: "V-999",
          amount: "50000",
        },
      );

      expect(event.payload.entityType).toBe("receipt");
      expect(event.payload.decision).toBe("APPROVED");
      expect(event.payload.entityType).not.toBe("pos_manager_verification");
    });

    it("يستمع ناقل الحلقات (onBridgeEvent) لكافة الأحداث المنشورة بنجاح", () => {
      const receivedEvents: RealtimeEvent[] = [];
      const unsub = onBridgeEvent((evt) => {
        receivedEvents.push(evt);
      });

      publishRealtimeEvent(REALTIME_EVENT_TYPES.NOTIFICATION_INSERTED, {
        userId: 55,
        title: "اختبار ناقل الحلقات",
        body: "محتوى",
      });

      expect(receivedEvents.length).toBe(1);
      expect(receivedEvents[0].type).toBe(REALTIME_EVENT_TYPES.NOTIFICATION_INSERTED);
      expect((receivedEvents[0].payload as any).title).toBe("اختبار ناقل الحلقات");

      unsub();
    });
  });
});
