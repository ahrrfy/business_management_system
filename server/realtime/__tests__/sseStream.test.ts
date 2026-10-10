import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SseManager } from "../sseManager";
import { createRealtimeEvent, REALTIME_EVENT_TYPES } from "@shared/realtimeEvents";
import { EventEmitter } from "node:events";

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

describe("sseManager — إدارة تدفق SSE ونبضات الـ Heartbeat وعزل الفروع", () => {
  let manager: SseManager;

  beforeEach(() => {
    manager = new SseManager();
  });

  afterEach(() => {
    manager.closeAll();
  });

  it("يسجل الاتصال ويطلق نبضات الحفاظ على الاتصال (ping) كل 15 ثانية", () => {
    vi.useFakeTimers();
    try {
      const { req, res } = createMockReqRes();

      manager.registerClient({
        id: "conn_1",
        userId: 10,
        role: "cashier",
        scopedBranchId: 1,
        companyId: null,
        req,
        res,
      });

      expect(manager.activeCount).toBe(1);

      // تقديم الوقت بـ 15 ثانية
      vi.advanceTimersByTime(15_000);

      // يجب أن تُرسل نبضة الحفاظ على الاتصال
      expect(res.write).toHaveBeenCalledWith(": ping\n\n");
      expect(res.writtenData).toContain(": ping\n\n");

      // تقديم الوقت بـ 15 ثانية أخرى
      vi.advanceTimersByTime(15_000);
      expect(res.write).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("يُطبّق العزل الأمني الصارم للفروع (scopedBranchId)", () => {
    const clientBranch1 = createMockReqRes();
    const clientBranch2 = createMockReqRes();
    const clientAdminCrossBranch = createMockReqRes();

    manager.registerClient({
      id: "conn_b1",
      userId: 1,
      role: "cashier",
      scopedBranchId: 1, // فرع 1 فقط
      req: clientBranch1.req,
      res: clientBranch1.res,
    });

    manager.registerClient({
      id: "conn_b2",
      userId: 2,
      role: "cashier",
      scopedBranchId: 2, // فرع 2 فقط
      req: clientBranch2.req,
      res: clientBranch2.res,
    });

    manager.registerClient({
      id: "conn_admin",
      userId: 99,
      role: "admin",
      scopedBranchId: null, // عابر للفروع (يستقبل الجميع)
      req: clientAdminCrossBranch.req,
      res: clientAdminCrossBranch.res,
    });

    // 1. حدث موجه للفرع 1 فقط
    const eventB1 = createRealtimeEvent(
      REALTIME_EVENT_TYPES.WORK_ORDER_CREATED,
      { workOrderId: 501 },
      { branchId: 1 },
    );

    const delivered1 = manager.broadcast(eventB1);
    expect(delivered1).toBe(2); // فرع 1 + الأدمن

    expect(clientBranch1.res.write).toHaveBeenCalledWith(
      expect.stringContaining(`"workOrderId":501`),
    );
    expect(clientAdminCrossBranch.res.write).toHaveBeenCalledWith(
      expect.stringContaining(`"workOrderId":501`),
    );
    expect(clientBranch2.res.write).not.toHaveBeenCalled();

    // 2. حدث موجه للفرع 2 فقط
    const eventB2 = createRealtimeEvent(
      REALTIME_EVENT_TYPES.WORK_ORDER_CREATED,
      { workOrderId: 502 },
      { branchId: 2 },
    );

    const delivered2 = manager.broadcast(eventB2);
    expect(delivered2).toBe(2); // فرع 2 + الأدمن

    expect(clientBranch2.res.write).toHaveBeenCalledWith(
      expect.stringContaining(`"workOrderId":502`),
    );
    expect(clientBranch1.res.write).toHaveBeenCalledTimes(1); // لم يزداد

    // 3. حدث عام لكافة الفروع (branchId: null)
    const eventGlobal = createRealtimeEvent(
      REALTIME_EVENT_TYPES.ANNOUNCEMENT_PUBLISHED,
      { text: "تنبيه عام" },
    );

    const delivered3 = manager.broadcast(eventGlobal);
    expect(delivered3).toBe(3); // كافة العملاء
  });

  it("يُطبّق عزل المستخدمين واستثناء الاتصال المصدر (excludeConnectionId)", () => {
    const c1 = createMockReqRes();
    const c2 = createMockReqRes();

    manager.registerClient({
      id: "conn_user_1",
      userId: 1,
      role: "cashier",
      scopedBranchId: 1,
      req: c1.req,
      res: c1.res,
    });

    manager.registerClient({
      id: "conn_user_2",
      userId: 2,
      role: "cashier",
      scopedBranchId: 1,
      req: c2.req,
      res: c2.res,
    });

    // حدث موجه للمستخدم 2 فقط
    const targetedUserEvent = createRealtimeEvent(
      REALTIME_EVENT_TYPES.NOTIFICATION_INSERTED,
      { text: "طلب خاص" },
      { userId: 2 },
    );

    const count1 = manager.broadcast(targetedUserEvent);
    expect(count1).toBe(1);
    expect(c2.res.write).toHaveBeenCalled();
    expect(c1.res.write).not.toHaveBeenCalled();

    // حدث يستثني conn_user_2
    const excludedEvent = createRealtimeEvent(
      REALTIME_EVENT_TYPES.HELD_ORDER_UPDATED,
      { heldId: 77 },
      { excludeConnectionId: "conn_user_2" },
    );

    const count2 = manager.broadcast(excludedEvent);
    expect(count2).toBe(1);
    expect(c1.res.write).toHaveBeenCalled();
  });

  it("ينظف الموارد فور إغلاق العميل للمتصفح أو انقطاع الاتصال (Memory Leak Prevention)", () => {
    const { req, res } = createMockReqRes();

    manager.registerClient({
      id: "conn_leak_test",
      userId: 5,
      role: "cashier",
      scopedBranchId: 1,
      req,
      res,
    });

    expect(manager.activeCount).toBe(1);

    // محاكاة إغلاق المتصفح للاتصال
    req.emit("close");

    expect(manager.activeCount).toBe(0);
    expect(manager.getStats().activeConnections).toBe(0);
  });

  it("يُطبّق عزل الشركات والمستأجرين الصارم (Multi-tenancy Company Isolation)", () => {
    const company1Client = createMockReqRes();
    const company2Client = createMockReqRes();

    manager.registerClient({
      id: "conn_comp_1",
      userId: 10,
      role: "admin",
      scopedBranchId: null,
      companyId: 1,
      req: company1Client.req,
      res: company1Client.res,
    });

    manager.registerClient({
      id: "conn_comp_2",
      userId: 20,
      role: "admin",
      scopedBranchId: null,
      companyId: 2,
      req: company2Client.req,
      res: company2Client.res,
    });

    // حدث خاص بشركة 1
    const eventCompany1 = createRealtimeEvent(
      REALTIME_EVENT_TYPES.WORK_ORDER_CREATED,
      { workOrderId: 701 },
      { companyId: 1 },
    );

    const delivered = manager.broadcast(eventCompany1);
    expect(delivered).toBe(1);
    expect(company1Client.res.write).toHaveBeenCalledWith(
      expect.stringContaining(`"workOrderId":701`),
    );
    expect(company2Client.res.write).not.toHaveBeenCalled();
  });
});
