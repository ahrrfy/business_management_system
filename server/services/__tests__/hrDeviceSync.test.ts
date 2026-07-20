// مزامنة أجهزة الحضور الحقيقية (0089) — جسر متعدد البروتوكولات + تخزين خام + طيّ.
//
// الثوابت المحروسة:
//   ج١) idempotency الخام: إعادة دفع نفس البصمة (انقطاع/إعادة إرسال) = صف واحد حتماً (uq_punch_sn_enroll_time).
//   ج٢) الطيّ: (موظف×يوم) أول بصمة دخول وآخرها خروج، الساعات الفارق، الأجر عبر recordAttendance
//       بسعر ساعة اليوم (لا منطق مالي مكرر) — وبصمة متأخرة تعيد حساب اليوم لا تفسده.
//   ج٣) بصمة واحدة = حضور بساعات صفر (لا اختلاق خروج).
//   ج٤) منتهي الخدمة: بصماته تُركن بوسم السبب ولا تنهار المعالجة ولا يتولد حضور.
//   ج٥) سائق aiface: جهاز مجهول يُرفض ويُسجَّل معطَّلاً (لا بصمات قبل اعتماد المدير)؛
//       المعتمد: reg⇒ack بوقتٍ للمزامنة، sendlog⇒ack+تخزين، senduser⇒مرآة، أوامر settime/getalllog
//       بدورة كاملة (قيد التنفيذ⇒مواصلة stn⇒إتمام) وsendlog المرفوض من مجهول لا يكتب شيئاً.
//   ج٦) سائق iclock: تحليل ATTLOG/OPERLOG النصي + دورة أمر getrequest/devicecmd.
//   ج٧) الربط اللاحق: mapUser يُلحق الموظف بالبصمات الخام السابقة فتُطوى — لا بصمة تضيع لتأخر الربط.
import { and, eq, isNull } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createAifaceSession } from "../hrDevices/aifaceDriver";
import { processPendingFolds } from "../hrDevices/attendanceFold";
import { enqueueCommand } from "../hrDevices/commands";
import { formatIclockCommand, parseAttlog, parseOperlogUsers } from "../hrDevices/iclockDriver";
import { ingestPunches, mapDeviceUserToEmployee, upsertDeviceUser } from "../hrDevices/punchStore";
import { resolveDeviceBySn } from "../hrDevices/registry";
import { truncateTables } from "./__testUtils__";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

const SN = "ZXRBTEST0001";

beforeEach(async () => {
  await truncateTables([
    "hrDeviceCommands",
    "hrAttendancePunches",
    "hrDeviceUsers",
    "hrFingerprintDevices",
    "attendance",
    "employees",
    "branches",
    "users",
  ]);
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values({ id: 1, openId: "a", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.employees).values([
    { id: 1, firstName: "أحمد", fatherName: "علي", lastName: "الجبوري", payType: "hourly", employmentStatus: "active" },
    { id: 2, firstName: "زينب", fatherName: "حسن", lastName: "الربيعي", payType: "hourly", employmentStatus: "terminated" },
  ]);
  await d.insert(s.hrFingerprintDevices).values({
    id: 10,
    name: "جهاز الرئيسي",
    serialNumber: SN,
    protocol: "AIFACE_WS",
    enabled: true,
    migrated: true,
  });
  await d.insert(s.hrDeviceUsers).values({ deviceId: 10, enrollId: 7, name: "احمد جهاز", employeeId: 1 });
});

async function device() {
  const [row] = await db().select().from(s.hrFingerprintDevices).where(eq(s.hrFingerprintDevices.id, 10)).limit(1);
  return row;
}

/** يحاكي تصحيح المدير اليدوي ليوم موظف ١ (مصدر manual) — لاختبار حارس عدم الطمس. */
async function recordAttendanceManual() {
  await db().insert(s.attendance).values({
    employeeId: 1,
    attendanceDate: "2026-07-01",
    status: "PRESENT",
    hours: "4.00",
    hourlyRate: "5000.00",
    amount: "20000.00",
    source: "manual",
  });
}

/** ناقل وهمي لسائق aiface: يلتقط المُرسَل ويتيح فحصه — لا مقابس حقيقية في الاختبار. */
function fakeTransport() {
  const sent: Array<Record<string, unknown>> = [];
  let closed = false;
  return {
    sent,
    isClosed: () => closed,
    transport: {
      sendText: (t: string) => sent.push(JSON.parse(t) as Record<string, unknown>),
      close: () => {
        closed = true;
      },
    },
  };
}

/** انتظار شرطٍ تحققه عمليات خلفية fire-and-forget (دفع الأوامر) — مهلة قصيرة حاسمة. */
async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("المخزن الخام (ج١)", () => {
  it("إعادة دفع نفس البصمة لا تضاعف الصفوف، والربط يُحلّ عند الاستلام", async () => {
    const dev = await device();
    const batch = [
      { enrollId: 7, punchAt: "2026-07-01 08:00:00", mode: "face" },
      { enrollId: 7, punchAt: "2026-07-01 16:30:00", mode: "face" },
      { enrollId: 99, punchAt: "2026-07-01 09:00:00" }, // غير مربوط — يُخزَّن بلا موظف
    ];
    const r1 = await ingestPunches(dev, batch);
    expect(r1.accepted).toBe(3);
    const r2 = await ingestPunches(dev, batch); // الجهاز أعاد الدفع بعد انقطاع
    expect(r2.accepted).toBe(3); // قُبلت شكلاً…
    const rows = await db().select().from(s.hrAttendancePunches);
    expect(rows.length).toBe(3); // …والقيد الفريد منع الازدواج فعلاً
    expect(rows.filter((r) => r.employeeId === 1).length).toBe(2);
    expect(rows.find((r) => r.enrollId === 99)?.employeeId).toBeNull();
  });

  it("توقيت مشوه أو enrollId فاسد يُرفض عدّاً ولا يفسد الدفعة", async () => {
    const dev = await device();
    const r = await ingestPunches(dev, [
      { enrollId: 7, punchAt: "ليس وقتاً" },
      { enrollId: Number.NaN, punchAt: "2026-07-01 08:00:00" },
      { enrollId: 7, punchAt: "2026-07-01T10:15:00" }, // صيغة T تُطبَّع
    ]);
    expect(r.accepted).toBe(1);
    expect(r.rejected).toBe(2);
    const rows = await db().select().from(s.hrAttendancePunches);
    expect(rows.length).toBe(1);
    expect(rows[0].punchAt).toContain("2026-07-01 10:15:00");
  });
});

describe("الطيّ إلى الحضور (ج٢–ج٤)", () => {
  it("بصمتا دخول/خروج تصيران يوم حضور بساعات وأجر يوم الأربعاء (ج٢)", async () => {
    const dev = await device();
    await ingestPunches(dev, [
      { enrollId: 7, punchAt: "2026-07-01 08:00:00" },
      { enrollId: 7, punchAt: "2026-07-01 16:30:00" },
    ]);
    const res = await processPendingFolds();
    expect(res.days).toBe(1);
    const [att] = await db().select().from(s.attendance).where(eq(s.attendance.employeeId, 1));
    expect(att).toBeTruthy();
    expect(String(att.hours)).toBe("8.50");
    // ٢٠٢٦-٠٧-٠١ أربعاء: السعر الافتراضي 5000 ⇒ 8.5 × 5000 = 42500
    expect(String(att.amount)).toBe("42500.00");
    expect(att.source).toBe("fingerprint");
    expect(att.checkIn?.toISOString()).toContain("08:00");
    expect(att.checkOut?.toISOString()).toContain("16:30");
    const raw = await db().select().from(s.hrAttendancePunches).where(isNull(s.hrAttendancePunches.processedAt));
    expect(raw.length).toBe(0);
  });

  it("بصمة متأخرة لنفس اليوم تعيد حساب اليوم كاملاً (ج٢)", async () => {
    const dev = await device();
    await ingestPunches(dev, [{ enrollId: 7, punchAt: "2026-07-01 08:00:00" }]);
    await processPendingFolds();
    // وصلت لاحقاً بصمة الخروج (كانت محبوسة في الجهاز)
    await ingestPunches(dev, [{ enrollId: 7, punchAt: "2026-07-01 14:00:00" }]);
    const res = await processPendingFolds();
    expect(res.days).toBe(1);
    const [att] = await db().select().from(s.attendance).where(eq(s.attendance.employeeId, 1));
    expect(String(att.hours)).toBe("6.00"); // اليوم أعيد حسابه: 08:00→14:00
  });

  it("بصمة واحدة = حضور بساعات صفر بلا اختلاق خروج (ج٣)", async () => {
    const dev = await device();
    await ingestPunches(dev, [{ enrollId: 7, punchAt: "2026-07-02 08:05:00" }]);
    await processPendingFolds();
    const [att] = await db().select().from(s.attendance).where(eq(s.attendance.employeeId, 1));
    expect(String(att.hours)).toBe("0.00");
    expect(att.checkOut).toBeNull();
  });

  it("منتهي الخدمة: تُركن بصماته بوسم السبب ولا يتولد حضور (ج٤)", async () => {
    const dev = await device();
    await db().insert(s.hrDeviceUsers).values({ deviceId: 10, enrollId: 8, employeeId: 2 });
    await ingestPunches(dev, [{ enrollId: 8, punchAt: "2026-07-01 08:00:00" }]);
    const res = await processPendingFolds();
    expect(res.parked).toBe(1);
    const atts = await db().select().from(s.attendance).where(eq(s.attendance.employeeId, 2));
    expect(atts.length).toBe(0);
    const [punch] = await db().select().from(s.hrAttendancePunches).where(eq(s.hrAttendancePunches.enrollId, 8));
    expect(punch.processedAt).toBeTruthy();
    expect(punch.processNote).toContain("منتهي الخدمة");
  });

  it("لا يطمس تصحيحاً يدوياً: يوم له إدخال يدوي تُركن بصماته بلا كتابة فوقه (تدقيق عدائي)", async () => {
    const dev = await device();
    // المدير سجّل اليوم يدوياً (تصحيح/إجازة) بمصدر manual.
    await recordAttendanceManual();
    await ingestPunches(dev, [
      { enrollId: 7, punchAt: "2026-07-01 08:00:00" },
      { enrollId: 7, punchAt: "2026-07-01 23:30:00" }, // بصمة سهو متأخرة
    ]);
    const res = await processPendingFolds();
    expect(res.days).toBe(0);
    const [att] = await db().select().from(s.attendance).where(eq(s.attendance.employeeId, 1));
    expect(att.source).toBe("manual"); // لم يُطمَس
    expect(String(att.hours)).toBe("4.00"); // قيمة المدير باقية
    const [punch] = await db().select().from(s.hrAttendancePunches).where(eq(s.hrAttendancePunches.enrollId, 7)).limit(1);
    expect(punch.processNote).toContain("يدوي");
  });
});

describe("سائق aiface (ج٥)", () => {
  it("جهاز مجهول: يُرفض التسجيل ويُنشأ صفاً معطَّلاً بانتظار الاعتماد", async () => {
    const { sent, transport, isClosed } = fakeTransport();
    const session = createAifaceSession(transport);
    await session.handleMessage(JSON.stringify({ cmd: "reg", sn: "UNKNOWN999", devinfo: {} }));
    expect(sent[0]).toMatchObject({ ret: "reg", result: false });
    expect(isClosed()).toBe(true);
    const [row] = await db()
      .select()
      .from(s.hrFingerprintDevices)
      .where(eq(s.hrFingerprintDevices.serialNumber, "UNKNOWN999"));
    expect(row).toBeTruthy();
    expect(row.enabled).toBe(false);
    // sendlog قبل تسجيل ناجح لا يكتب شيئاً
    await session.handleMessage(
      JSON.stringify({ cmd: "sendlog", record: [{ enrollid: 7, time: "2026-07-01 08:00:00" }] })
    );
    const punches = await db().select().from(s.hrAttendancePunches);
    expect(punches.length).toBe(0);
    await session.handleClose();
  });

  it("الدورة الكاملة: reg يُحدّث devInfo ويزامن الوقت، sendlog يُخزّن ويُقرّ، senduser يرقّي المرآة", async () => {
    const { sent, transport } = fakeTransport();
    const session = createAifaceSession(transport);
    await session.handleMessage(
      JSON.stringify({
        cmd: "reg",
        sn: SN,
        devinfo: { modelname: "AI518", firmware: "ai518_f43h_v1.21", useduser: 61, usedlog: 36373 },
      })
    );
    const regAck = sent.find((m) => m.ret === "reg");
    expect(regAck).toMatchObject({ ret: "reg", result: true });
    expect(String(regAck?.cloudtime)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/); // مزامنة الساعة
    const dev = await device();
    expect(dev.firmware).toBe("ai518_f43h_v1.21");
    expect(dev.usersCount).toBe(61);
    expect(dev.recordsCount).toBe(36373);
    expect(dev.lastHandshakeAt).toBeTruthy();

    await session.handleMessage(
      JSON.stringify({
        cmd: "sendlog",
        count: 2,
        logindex: 5,
        record: [
          { enrollid: 7, time: "2026-07-03 08:00:00", mode: 8, inout: 0 },
          { enrollid: 7, time: "2026-07-03 17:00:00", mode: 8, inout: 1 },
        ],
      })
    );
    const logAck = sent.find((m) => m.ret === "sendlog");
    expect(logAck).toMatchObject({ ret: "sendlog", result: true, count: 2, logindex: 5 });
    const punches = await db().select().from(s.hrAttendancePunches);
    expect(punches.length).toBe(2);
    expect(punches[0].mode).toBe("face");
    expect(punches.map((p) => p.inOut).sort()).toEqual(["in", "out"]);

    await session.handleMessage(
      JSON.stringify({ cmd: "senduser", enrollid: 15, name: "كريم", admin: 0, backupnum: 50, record: "قالب-وجه" })
    );
    expect(sent.find((m) => m.ret === "senduser")).toMatchObject({ result: true });
    const [du] = await db()
      .select()
      .from(s.hrDeviceUsers)
      .where(and(eq(s.hrDeviceUsers.deviceId, 10), eq(s.hrDeviceUsers.enrollId, 15)));
    expect(du.name).toBe("كريم");
    expect((du.backupData as Record<string, unknown>)["50"]).toBe("قالب-وجه");
    await session.handleClose();
  });

  it("دورة الأوامر: settime يُدفع عند الاتصال ويكتمل بردّ الجهاز، وgetalllog يواصل stn حتى الاكتمال", async () => {
    await enqueueCommand(10, "settime", null, 1);
    const { sent, transport } = fakeTransport();
    const session = createAifaceSession(transport);
    await session.handleMessage(JSON.stringify({ cmd: "reg", sn: SN, devinfo: {} }));
    await waitFor(() => sent.some((m) => m.cmd === "settime"));
    expect(String(sent.find((m) => m.cmd === "settime")?.cloudtime)).toMatch(/^\d{4}-/);
    await session.handleMessage(JSON.stringify({ ret: "settime", result: true }));
    await waitFor(() => true);
    const [cmd1] = await db().select().from(s.hrDeviceCommands).where(eq(s.hrDeviceCommands.cmd, "settime"));
    await waitFor(() => cmd1 !== undefined);
    // الإتمام غير متزامن — نستطلع الحالة حتى تستقر done
    await waitFor(() => sent.length >= 2);
    const done = async () =>
      (await db().select().from(s.hrDeviceCommands).where(eq(s.hrDeviceCommands.cmd, "settime")))[0]?.status;
    let st = await done();
    const start = Date.now();
    while (st !== "done" && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 25));
      st = await done();
    }
    expect(st).toBe("done");

    // getalllog بدفعتين: count=4 والسجلات تصل ٢+٢ — المواصلة بـ stn:false ثم الإتمام
    await enqueueCommand(10, "getalllog", null, 1);
    await waitFor(() => sent.some((m) => m.cmd === "getalllog" && m.stn === true));
    await session.handleMessage(
      JSON.stringify({
        ret: "getalllog",
        result: true,
        count: 4,
        record: [
          { enrollid: 7, time: "2026-06-01 08:00:00" },
          { enrollid: 7, time: "2026-06-01 16:00:00" },
        ],
      })
    );
    await waitFor(() => sent.some((m) => m.cmd === "getalllog" && m.stn === false));
    await session.handleMessage(
      JSON.stringify({
        ret: "getalllog",
        result: true,
        count: 4,
        record: [
          { enrollid: 7, time: "2026-06-02 08:00:00" },
          { enrollid: 7, time: "2026-06-02 16:00:00" },
        ],
      })
    );
    const allDone = async () =>
      (await db().select().from(s.hrDeviceCommands).where(eq(s.hrDeviceCommands.cmd, "getalllog")))[0];
    let row = await allDone();
    const s2 = Date.now();
    while (row?.status !== "done" && Date.now() - s2 < 2000) {
      await new Promise((r) => setTimeout(r, 25));
      row = await allDone();
    }
    expect(row?.status).toBe("done");
    expect((row?.result as { received?: number })?.received).toBe(4);
    const historic = await db().select().from(s.hrAttendancePunches);
    expect(historic.length).toBe(4); // التاريخ سُحب من ذاكرة الجهاز
    await session.handleClose();
  });
});

describe("سائق iclock (ج٦)", () => {
  it("يحلل ATTLOG النصي بوسم الوسيلة والاتجاه", () => {
    const punches = parseAttlog("7\t2026-07-01 08:00:00\t0\t15\t0\n7\t2026-07-01 16:00:00\t1\t1\t0\n\n");
    expect(punches.length).toBe(2);
    expect(punches[0]).toMatchObject({ enrollId: 7, punchAt: "2026-07-01 08:00:00", mode: "face", inOut: "in" });
    expect(punches[1]).toMatchObject({ mode: "fp", inOut: "out" });
  });

  it("يحلل مستخدمي OPERLOG ويصيغ أوامر السلك", () => {
    const users = parseOperlogUsers("USER PIN=3\tName=سيف\tPri=14\tCard=12345\nOPLOG 1\t...\n");
    expect(users).toEqual([{ enrollId: 3, name: "سيف", isAdmin: true, cardNo: "12345" }]);
    expect(formatIclockCommand(9, "getnewlog")).toBe("C:9:CHECK");
    expect(formatIclockCommand(9, "reboot")).toBe("C:9:REBOOT");
  });

  it("جهاز ZK يسجّل نفسه تلقائياً معطَّلاً بنفس بوابة القبول", async () => {
    const row = await resolveDeviceBySn("ZKTEST777", "ZKTECO_PUSH");
    expect(row?.enabled).toBe(false);
    expect(row?.protocol).toBe("ZKTECO_PUSH");
    // إعادة الحل لا تنشئ صفاً ثانياً (سباق التسجيل يحسمه القيد الفريد)
    const again = await resolveDeviceBySn("ZKTEST777", "ZKTECO_PUSH");
    expect(again?.id).toBe(row?.id);
  });
});

describe("الربط اللاحق (ج٧)", () => {
  it("mapUser يُلحق الموظف بالبصمات الخام السابقة فتُطوى", async () => {
    const dev = await device();
    await ingestPunches(dev, [
      { enrollId: 55, punchAt: "2026-07-05 08:00:00" },
      { enrollId: 55, punchAt: "2026-07-05 15:00:00" },
    ]);
    let pend = await processPendingFolds();
    expect(pend.days).toBe(0); // غير مربوط — لا شيء يُطوى ولا شيء يضيع
    await upsertDeviceUser(dev, { enrollId: 55, name: "مجهول سابقاً" });
    const backfilled = await mapDeviceUserToEmployee(10, 55, 1);
    expect(backfilled).toBe(2);
    pend = await processPendingFolds();
    expect(pend.days).toBe(1);
    const [att] = await db().select().from(s.attendance).where(eq(s.attendance.employeeId, 1));
    expect(String(att.hours)).toBe("7.00");
  });
});
