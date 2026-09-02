import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceLink } from "../types";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.doUnmock("../../tx");
  vi.doUnmock("../../../logger");
  vi.doUnmock("../registry");
  vi.doUnmock("../../attendanceService");
  vi.doUnmock("../../appNotificationService");
  vi.doUnmock("../../pushService");
  vi.doUnmock("../../sessionEventNotifier");
});

describe("تصريف مهام عامل جسر الحضور", () => {
  it("يوجّه حدث البصمة للموظف وللإدارة باسم الموظف ولا يخلطه بدخول الحساب", async () => {
    const { buildAttendanceNotificationDeliveries } = await import(
      "../attendanceNotification"
    );

    const deliveries = buildAttendanceNotificationDeliveries({
      employeeId: 91,
      employeeUserId: 9,
      employeeDisplayName: "أحمد علي",
      adminRecipientUserIds: [1, 2, 9, 2],
      attendanceId: 501,
      attendanceDate: "2026-09-02",
      movement: "ATTENDANCE_CHECK_IN",
      clock: "08:05",
      needsReview: false,
    });

    expect(deliveries).toEqual([
      expect.objectContaining({
        userId: 9,
        title: "تم تسجيل الحضور",
        eventKey: "attendance:91:2026-09-02:ATTENDANCE_CHECK_IN",
        push: true,
      }),
      expect.objectContaining({
        userId: 1,
        title: "أحمد علي سجل حضور",
        eventKey:
          "attendance-admin:91:2026-09-02:ATTENDANCE_CHECK_IN:1",
        push: true,
      }),
      expect.objectContaining({
        userId: 2,
        title: "أحمد علي سجل حضور",
        eventKey:
          "attendance-admin:91:2026-09-02:ATTENDANCE_CHECK_IN:2",
        push: true,
      }),
    ]);

    const checkOutDeliveries = buildAttendanceNotificationDeliveries({
      employeeId: 91,
      employeeUserId: 9,
      employeeDisplayName: "أحمد علي",
      adminRecipientUserIds: [1],
      attendanceId: 501,
      attendanceDate: "2026-09-02",
      movement: "ATTENDANCE_CHECK_OUT",
      clock: "16:05",
      needsReview: false,
    });

    expect(checkOutDeliveries).toEqual([
      expect.objectContaining({
        userId: 9,
        title: "تم تسجيل الانصراف",
      }),
      expect.objectContaining({
        userId: 1,
        title: "أحمد علي سجل انصراف",
        eventKey:
          "attendance-admin:91:2026-09-02:ATTENDANCE_CHECK_OUT:1",
      }),
    ]);
  });

  it("لا يرسل إشعاراً إدارياً عند تسجيل الدخول إلى الحساب", async () => {
    const createAppNotification = vi.fn();
    const db = {
      select: vi.fn(() => ({
        from: () => ({
          where: async () => [{ id: 1 }],
        }),
      })),
    };

    vi.doMock("../../tx", () => ({ requireDb: () => db }));
    vi.doMock("../../appNotificationService", () => ({
      createAppNotification,
    }));

    const { notifyAdminsOfSessionEvent } = await import(
      "../../sessionEventNotifier"
    );
    await notifyAdminsOfSessionEvent({
      userId: 9,
      userBranchId: 1,
      userDisplayName: "أحمد علي",
      kind: "LOGIN",
      sessionId: 77,
      occurredAt: new Date("2026-09-02T05:05:00.000Z"),
    });

    expect(db.select).not.toHaveBeenCalled();
    expect(createAppNotification).not.toHaveBeenCalled();
  });

  it("يعيد claim المتزامن مع الإغلاق إلى queued ولا يرسل على وصلة ميتة", async () => {
    const claimStarted = deferred();
    const releaseClaim = deferred();
    const send = vi.fn();
    const rollbackValues: unknown[] = [];
    let selectCalls = 0;

    const link: DeviceLink = {
      deviceId: 7,
      serialNumber: "SN-7",
      protocol: "AIFACE_WS",
      send,
      close: vi.fn(),
      inflight: null,
    };
    const next = {
      id: 41,
      deviceId: 7,
      cmd: "getnewlog",
      payload: null,
    };
    const db = {
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async () => {
                selectCalls++;
                return [next];
              },
            }),
          }),
        }),
      })),
      update: vi.fn(() => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            if (values.status === "sent") {
              claimStarted.resolve();
              await releaseClaim.promise;
              return [{ affectedRows: 1 }];
            }
            rollbackValues.push(values);
            return [{ affectedRows: 1 }];
          },
        }),
      })),
    };

    vi.doMock("../../tx", () => ({ requireDb: () => db }));
    vi.doMock("../../../logger", () => ({ logger }));
    vi.doMock("../registry", () => ({ getLink: () => link }));

    const { pumpCommands, stopAndDrainCommandPumps } = await import(
      "../commands"
    );
    pumpCommands(link.deviceId);
    await claimStarted.promise;

    const draining = stopAndDrainCommandPumps();
    let settled = false;
    void draining.then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    releaseClaim.resolve();
    await draining;

    expect(send).not.toHaveBeenCalled();
    expect(link.inflight).toBeNull();
    expect(rollbackValues).toContainEqual({ status: "queued", sentAt: null });

    pumpCommands(link.deviceId);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(selectCalls).toBe(1);
  });

  it("يسترد claim iClock إذا أُلغي الطلب أثناء UPDATE", async () => {
    const claimStarted = deferred();
    const releaseClaim = deferred();
    const statuses: unknown[] = [];
    const controller = new AbortController();
    const next = { id: 52, cmd: "getnewlog" };
    const db = {
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({ limit: async () => [next] }),
          }),
        }),
      })),
      update: vi.fn(() => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            statuses.push(values.status);
            if (values.status === "sent") {
              claimStarted.resolve();
              await releaseClaim.promise;
            }
            return [{ affectedRows: 1 }];
          },
        }),
      })),
    };

    vi.doMock("../../tx", () => ({ requireDb: () => db }));
    vi.doMock("../../../logger", () => ({ logger }));
    vi.doMock("../registry", () => ({ getLink: () => undefined }));

    const { popIclockCommand } = await import("../commands");
    const popping = popIclockCommand(7, controller.signal);
    await claimStarted.promise;
    controller.abort();
    releaseClaim.resolve();

    await expect(popping).resolves.toBeNull();
    // queued الأولى هي stale-lease recovery، والأخيرة rollback للclaim الملغى.
    expect(statuses).toEqual(["queued", "sent", "queued"]);
  });

  it("يسترد claim iClock إذا أُغلقت بوابة الأوامر أثناء UPDATE", async () => {
    const claimStarted = deferred();
    const releaseClaim = deferred();
    const statuses: unknown[] = [];
    const next = { id: 53, cmd: "getnewlog" };
    const db = {
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({ limit: async () => [next] }),
          }),
        }),
      })),
      update: vi.fn(() => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            statuses.push(values.status);
            if (values.status === "sent") {
              claimStarted.resolve();
              await releaseClaim.promise;
            }
            return [{ affectedRows: 1 }];
          },
        }),
      })),
    };

    vi.doMock("../../tx", () => ({ requireDb: () => db }));
    vi.doMock("../../../logger", () => ({ logger }));
    vi.doMock("../registry", () => ({ getLink: () => undefined }));

    const { popIclockCommand, stopAndDrainCommandPumps } = await import(
      "../commands"
    );
    const popping = popIclockCommand(7);
    await claimStarted.promise;

    // SIGTERM يستدعي هذه البوابة تزامنياً قبل bridge.stop/closeDb.
    await stopAndDrainCommandPumps();
    releaseClaim.resolve();

    await expect(popping).resolves.toBeNull();
    expect(statuses).toEqual(["queued", "sent", "queued"]);
  });

  it("يمنع طيّاً جديداً وينتظر الطي الجاري قبل إغلاق قاعدة البيانات", async () => {
    const selectStarted = deferred();
    const releaseSelect = deferred<unknown[]>();
    let selectCalls = 0;
    const db = {
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async () => {
                selectCalls++;
                selectStarted.resolve();
                return releaseSelect.promise;
              },
            }),
          }),
        }),
      })),
    };

    vi.doMock("../../tx", () => ({ requireDb: () => db }));
    vi.doMock("../../../logger", () => ({ logger }));
    vi.doMock("../../attendanceService", () => ({
      recordAttendance: vi.fn(),
    }));
    vi.doMock("../../appNotificationService", () => ({
      createAppNotification: vi.fn(),
    }));

    const {
      foldSoon,
      stopAndDrainAttendanceFolds,
    } = await import("../attendanceFold");
    foldSoon();
    await selectStarted.promise;

    const draining = stopAndDrainAttendanceFolds();
    foldSoon();
    let settled = false;
    void draining.then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(selectCalls).toBe(1);

    releaseSelect.resolve([]);
    await draining;
    foldSoon();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(settled).toBe(true);
    expect(selectCalls).toBe(1);
  });

  it("يكمل دفعة الطي الجارية فقط عند الإغلاق ولا يبدأ دفعة backlog أخرى", async () => {
    const selectStarted = deferred();
    const releaseFirstSelect = deferred<unknown[]>();
    const recordAttendance = vi.fn(async () => ({ id: 91 }));
    const rowsBySelect = [
      releaseFirstSelect.promise,
      Promise.resolve([]), // إعدادات الطي
      Promise.resolve([]), // حارس الإدخال اليدوي
      Promise.resolve([
        { punchAt: "2020-01-01 08:00:00" },
        { punchAt: "2020-01-01 16:00:00" },
      ]),
      Promise.resolve([{ userId: null, workSchedule: null }]),
    ];
    let selectCalls = 0;
    const db = {
      select: vi.fn(() => {
        const index = selectCalls++;
        const rows = () => {
          if (index === 0) selectStarted.resolve();
          return rowsBySelect[index] ?? Promise.resolve([]);
        };
        const query: Record<string, unknown> & PromiseLike<unknown[]> = {
          from: () => query,
          where: () => query,
          orderBy: () => query,
          limit: () => rows(),
          then: (resolve, reject) => rows().then(resolve, reject),
        };
        return query;
      }),
      update: vi.fn(() => ({
        set: () => ({ where: async () => [{ affectedRows: 1 }] }),
      })),
    };

    vi.doMock("../../tx", () => ({ requireDb: () => db }));
    vi.doMock("../../../logger", () => ({ logger }));
    vi.doMock("../../attendanceService", () => ({ recordAttendance }));
    vi.doMock("../../appNotificationService", () => ({
      createAppNotification: vi.fn(),
    }));

    const { foldSoon, stopAndDrainAttendanceFolds } = await import(
      "../attendanceFold"
    );
    foldSoon();
    await selectStarted.promise;

    const draining = stopAndDrainAttendanceFolds();
    let settled = false;
    void draining.then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    releaseFirstSelect.resolve([
      { id: 1, employeeId: 1, punchAt: "2020-01-01 08:00:00" },
    ]);
    await draining;

    expect(recordAttendance).toHaveBeenCalledOnce();
    // ٥ استعلامات للدفعة الأولى؛ السادس كان سيكون SELECT دفعة backlog جديدة.
    expect(selectCalls).toBe(5);
  });

  it("لا يفقد طلب طي يصل بين اكتمال الدورة وتحرير المنسّق", async () => {
    let selectCalls = 0;
    const db = {
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async () => {
                selectCalls++;
                return [];
              },
            }),
          }),
        }),
      })),
    };

    vi.doMock("../../tx", () => ({ requireDb: () => db }));
    vi.doMock("../../../logger", () => ({ logger }));
    vi.doMock("../../attendanceService", () => ({
      recordAttendance: vi.fn(),
    }));
    vi.doMock("../../appNotificationService", () => ({
      createAppNotification: vi.fn(),
    }));

    const {
      foldSoon,
      processPendingFolds,
      stopAndDrainAttendanceFolds,
    } = await import("../attendanceFold");

    const firstRun = processPendingFolds();
    // مع limit async يضع الهوب الثاني طلب foldSoon بعد آخر فحص rerun
    // وقبل reaction الذي يصفّر activeFoldRun: وهي نافذة lost-wakeup نفسها.
    queueMicrotask(() => queueMicrotask(foldSoon));
    await firstRun;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(selectCalls).toBe(2);
    await stopAndDrainAttendanceFolds();
  });

  it("يعيد محاولة فشل SELECT الأولي دون انتظار بصمة جديدة", async () => {
    vi.useFakeTimers();
    let selectCalls = 0;
    const db = {
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async () => {
                selectCalls++;
                if (selectCalls === 1) throw new Error("temporary database outage");
                return [];
              },
            }),
          }),
        }),
      })),
    };

    vi.doMock("../../tx", () => ({ requireDb: () => db }));
    vi.doMock("../../../logger", () => ({ logger }));
    vi.doMock("../../attendanceService", () => ({
      recordAttendance: vi.fn(),
    }));
    vi.doMock("../../appNotificationService", () => ({
      createAppNotification: vi.fn(),
    }));

    const { foldSoon, stopAndDrainAttendanceFolds } = await import(
      "../attendanceFold"
    );

    try {
      foldSoon();
      await vi.advanceTimersByTimeAsync(0);
      expect(selectCalls).toBe(1);

      await vi.advanceTimersByTimeAsync(14_999);
      expect(selectCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(selectCalls).toBe(2);
    } finally {
      await stopAndDrainAttendanceFolds();
      vi.useRealTimers();
    }
  });

  it("يحفظ إشعار العامل وnative outbox ويطلق Web Push دون انتظاره", async () => {
    const pushStarted = deferred();
    const sendPushToUser = vi.fn(() => {
      pushStarted.resolve();
      // قناة PWA قد تتأخر؛ لا يجوز أن تحجز طيّ الحضور أو مهلة shutdown.
      return new Promise<never>(() => undefined);
    });
    const inserted: unknown[] = [];
    const tx = {
      insert: vi.fn(() => ({
        values: async (values: unknown) => {
          inserted.push(values);
        },
      })),
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({ limit: async () => [] }),
        }),
      })),
    };
    const db = {
      transaction: vi.fn(
        async (work: (value: typeof tx) => Promise<void>) => work(tx),
      ),
    };

    vi.doMock("../../tx", () => ({ requireDb: () => db }));
    vi.doMock("../../pushService", () => ({
      isPushEnabled: () => true,
      sendPushToUser,
    }));

    const { createAppNotification } = await import(
      "../../appNotificationService"
    );
    const creating = createAppNotification({
      userId: 9,
      kind: "ATTENDANCE",
      title: "تم تسجيل الحضور",
      body: "09:00",
      route: "/mobile#attendance",
      eventKey: "attendance:9:2026-08-10:ATTENDANCE_CHECK_IN",
      lockScreenSafe: true,
      push: true,
    });
    await pushStarted.promise;

    let settled = false;
    void creating.then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(inserted).toHaveLength(2);
    expect(sendPushToUser).toHaveBeenCalledOnce();
    expect(settled).toBe(true);
    await expect(creating).resolves.toEqual({ created: true });
  });
});
