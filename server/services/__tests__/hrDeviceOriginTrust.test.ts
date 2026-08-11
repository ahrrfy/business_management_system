// ثقة مصدر أجهزة الحضور — «العنوان يُتعلَّم لا يُكتَب» (هجرة 0171).
//
// سبب الشريحة (عطل إنتاجيّ ١١/٨/٢٦): مزوّد الإنترنت غيّر عنوان المتجر العامّ ليلاً
// (‎.9.235 ⇒ ‎.10.103)، فصدّت بوّابتا الأمان جهازَ البصمة **ثماني ساعات بصمت**، ولم يكن
// للتعافي سبيلٌ إلا SSH وتعديلٌ يدويّ (لا شاشة أصلاً لتعديل عنوان الجهاز).
//
// الثوابت المحروسة هنا:
//   ث١) البوّابة الأولى تقبل عنواناً **مُتعلَّماً** من القاعدة ولو غاب عن قائمة ‎.env — وإلا
//       بقي التعافي مرهوناً بـSSH. ومع ذلك لا تقبل عنواناً غريباً غير مُتعلَّم.
//   ث٢) القرينة صادقة: جلسةٌ **حيّة لموظّفٍ فعّالٍ من فرع الجهاز** فقط تُعزّز العنوان.
//       الملغاة/المنتهية/الراكدة/من فرعٍ آخر/لموظّفٍ معطَّل ⇒ لا تعزيز.
//   ث٣) الاعتماد التلقائيّ يمرّ **من البوّابة نفسها بعد التحديث** — لا التفاف عليها.
//   ث٤) بلا قرينة ⇒ رفضٌ كما اليوم + محاولةٌ **مرئيّة** بعدّاد (لا إغراق: صفٌّ واحد لكل
//       رقم تسلسليّ×عنوان مهما بلغ الإلحاح).
//   ث٥) الربط الصريح في ‎.env يغلب التعلُّم دائماً (نيّة المشغّل لا يدهسها آليّ).
//   ث٦) مفتاح الإيقاف يُعطّل التلقائية ويُبقي الرصد.
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createAifaceSession } from "../hrDevices/aifaceDriver";
import { isRemoteAllowed } from "../hrDevices/bridgeSecurity";
import {
  isOriginCorroborated,
  listPendingOriginAttempts,
  loadLearnedOrigins,
  recordBlockedOrigin,
  resetBlockedOriginThrottleForTest,
  resolveOriginTrustConfig,
} from "../hrDevices/originTrust";
import { updateDevice } from "../hrDeviceService";
import { truncateTables } from "./__testUtils__";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

const SN = "ZXRBORIGIN01";
const OLD_IP = "169.224.9.235";
const NEW_IP = "169.224.10.103";
const WINDOW_HOURS = 12;

/** جلسة موظّف مُصادَقة — القرينة الوحيدة المقبولة على أنّ العنوان عنوان المتجر. */
async function seedSession(opts: {
  userId: number;
  ip: string;
  lastSeenAgoMs?: number;
  expiresInMs?: number;
  revoked?: boolean;
}) {
  const now = Date.now();
  await db()
    .insert(s.userSessions)
    .values({
      userId: opts.userId,
      ipAddress: opts.ip,
      userAgent: "test",
      lastSeenAt: new Date(now - (opts.lastSeenAgoMs ?? 60_000)),
      expiresAt: new Date(now + (opts.expiresInMs ?? 86_400_000)),
      revokedAt: opts.revoked ? new Date(now - 1000) : null,
    });
}

/** «شبكة عمل»: عدّة موظّفين متمايزين من العنوان نفسه — العتبة التي تفرّقها عن منزل فرد. */
async function seedWitnesses(
  ip: string,
  userIds: number[],
  opts: { lastSeenAgoMs?: number; expiresInMs?: number; revoked?: boolean } = {},
) {
  for (const userId of userIds) await seedSession({ userId, ip, ...opts });
}

function fakeTransport(remote: string) {
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
      remote,
    },
  };
}

async function deviceRow() {
  const [row] = await db()
    .select()
    .from(s.hrFingerprintDevices)
    .where(eq(s.hrFingerprintDevices.serialNumber, SN))
    .limit(1);
  return row;
}

async function reg(remote: string) {
  const t = fakeTransport(remote);
  const session = createAifaceSession(t.transport);
  await session.handleMessage(JSON.stringify({ cmd: "reg", sn: SN, devinfo: {} }));
  return t;
}

beforeEach(async () => {
  await truncateTables([
    "hrDeviceOriginAttempts",
    "hrDeviceCommands",
    "hrAttendancePunches",
    "hrDeviceUsers",
    "hrFingerprintDevices",
    "userSessions",
    "employees",
    "branches",
    "users",
  ]);
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "a", name: "موظّف الفرع", role: "cashier", loginMethod: "local", branchId: 1, isActive: true },
    { id: 2, openId: "b", name: "موظّف فرعٍ آخر", role: "cashier", loginMethod: "local", branchId: 2, isActive: true },
    { id: 3, openId: "c", name: "معطَّل", role: "cashier", loginMethod: "local", branchId: 1, isActive: false },
    { id: 4, openId: "d", name: "زميل الفرع", role: "cashier", loginMethod: "local", branchId: 1, isActive: true },
    { id: 5, openId: "e", name: "زميل فرعٍ آخر", role: "cashier", loginMethod: "local", branchId: 2, isActive: true },
  ]);
  await d.insert(s.hrFingerprintDevices).values({
    id: 10,
    name: "البصمة الرئيسية",
    serialNumber: SN,
    protocol: "AIFACE_WS",
    branchId: 1,
    enabled: true,
    migrated: true,
    ip: OLD_IP,
  });
  delete process.env.HR_DEVICE_ORIGIN_AUTOTRUST;
  delete process.env.HR_DEVICE_IDENTITY_BINDINGS;
});

describe("ث١ — البوّابة الأولى تقبل العنوان المُتعلَّم", () => {
  it("عنوانٌ خارج قائمة .env يُقبل إن كان مُتعلَّماً، ويُرفض إن لم يكن", () => {
    const allowlist = [OLD_IP];
    const learned = new Set([NEW_IP]);
    expect(isRemoteAllowed(NEW_IP, allowlist)).toBe(false); // السلوك القديم — سبب العطل
    expect(isRemoteAllowed(NEW_IP, allowlist, learned)).toBe(true);
    expect(isRemoteAllowed("8.8.8.8", allowlist, learned)).toBe(false);
    expect(isRemoteAllowed(OLD_IP, allowlist, learned)).toBe(true);
  });

  it("قائمة فارغة تبقى متساهلة كما كانت (لا تغيير سلوكيّ)", () => {
    expect(isRemoteAllowed("8.8.8.8", [], new Set())).toBe(true);
  });

  it("التعلُّم يجمع عنوان الجهاز المُفعَّل + عنوان «شبكة عمل» بشهودٍ متعدّدين", async () => {
    await seedWitnesses(NEW_IP, [1, 4]);
    const learned = await loadLearnedOrigins(WINDOW_HOURS);
    expect(learned.has(OLD_IP)).toBe(true); // عنوان الجهاز المخزَّن — لا يخضع لأيّ سقف
    expect(learned.has(NEW_IP)).toBe(true); // العنوان الجديد من شبكة العمل
  });

  it("عنوان موظّفٍ واحدٍ (منزله) لا يدخل التعلُّم، وعنوان الجهاز يبقى دائماً", async () => {
    await seedSession({ userId: 1, ip: "5.5.5.5" });
    const learned = await loadLearnedOrigins(WINDOW_HOURS);
    expect(learned.has("5.5.5.5")).toBe(false);
    expect(learned.has(OLD_IP)).toBe(true);
  });
});

describe("ث٢ — القرينة صادقة", () => {
  it("شبكة عمل (موظّفان متمايزان) تُعزّز", async () => {
    await seedWitnesses(NEW_IP, [1, 4]);
    await expect(isOriginCorroborated(1, NEW_IP, WINDOW_HOURS)).resolves.toBe(true);
  });

  it("⭐ موظّفٌ واحدٌ لا يُعزّز — ولو بجلساتٍ متعدّدة (يمنع انتحال الجهاز من منزل موظّف)", async () => {
    await seedSession({ userId: 1, ip: NEW_IP });
    await seedSession({ userId: 1, ip: NEW_IP });
    await seedSession({ userId: 1, ip: NEW_IP });
    await expect(isOriginCorroborated(1, NEW_IP, WINDOW_HOURS)).resolves.toBe(false);
    // العتبة قابلة للضبط لمن يقبل أثرها صراحةً.
    await expect(isOriginCorroborated(1, NEW_IP, WINDOW_HOURS, 1)).resolves.toBe(true);
  });

  it("جلسات ملغاة أو منتهية أو راكدة لا تُعزّز", async () => {
    await seedWitnesses(NEW_IP, [1, 4], { revoked: true });
    await expect(isOriginCorroborated(1, NEW_IP, WINDOW_HOURS)).resolves.toBe(false);

    await truncateTables(["userSessions"]);
    await seedWitnesses(NEW_IP, [1, 4], { expiresInMs: -1000 });
    await expect(isOriginCorroborated(1, NEW_IP, WINDOW_HOURS)).resolves.toBe(false);

    await truncateTables(["userSessions"]);
    await seedWitnesses(NEW_IP, [1, 4], { lastSeenAgoMs: 24 * 3600_000 });
    await expect(isOriginCorroborated(1, NEW_IP, WINDOW_HOURS)).resolves.toBe(false);
  });

  it("موظّفو فرعٍ آخر أو موظّفٌ معطَّل لا يُعزّزون فرع الجهاز", async () => {
    await seedWitnesses(NEW_IP, [2, 5]); // الفرع ٢
    await seedSession({ userId: 3, ip: NEW_IP }); // معطَّل
    await expect(isOriginCorroborated(1, NEW_IP, WINDOW_HOURS)).resolves.toBe(false);
  });

  it("صيغة IPv4 المُغلَّفة في الجلسة تطابق الصيغة المجرّدة التي يراها الجسر", async () => {
    await seedWitnesses(`::ffff:${NEW_IP}`, [1, 4]);
    await expect(isOriginCorroborated(1, NEW_IP, WINDOW_HOURS)).resolves.toBe(true);
  });
});

describe("ث٣/ث٤ — الاعتماد التلقائي والرصد", () => {
  it("عنوانٌ جديد مُعزَّز ⇒ يُقبل التسجيل ويُحدَّث عنوان الجهاز وتُحسم المحاولة تلقائياً", async () => {
    await seedWitnesses(NEW_IP, [1, 4]);
    const t = await reg(NEW_IP);

    expect(t.sent[0]).toMatchObject({ ret: "reg", result: true });
    expect(t.isClosed()).toBe(false);
    expect((await deviceRow()).ip).toBe(NEW_IP);

    const [attempt] = await db().select().from(s.hrDeviceOriginAttempts);
    expect(attempt.resolution).toBe("AUTO");
    expect(attempt.resolvedAt).not.toBeNull();
    expect(attempt.resolvedBy).toBeNull(); // فاعلٌ آليّ لا بشريّ — صدقٌ في أثر التدقيق
    expect(await listPendingOriginAttempts()).toHaveLength(0);
  });

  it("بلا قرينة ⇒ رفضٌ كما اليوم، ومحاولةٌ معلّقة مرئيّة بعدّاد لا صفوفٌ مكرّرة", async () => {
    await reg(NEW_IP);
    await reg(NEW_IP);
    await reg(NEW_IP);

    expect((await deviceRow()).ip).toBe(OLD_IP); // لم يُمسّ
    const rows = await db().select().from(s.hrDeviceOriginAttempts);
    expect(rows).toHaveLength(1); // ث٤: لا إغراق مهما تكرّر الإلحاح
    expect(rows[0].attemptCount).toBe(3);
    expect(rows[0].decision).toBe("IP_MISMATCH");
    expect(rows[0].resolvedAt).toBeNull();

    const pending = await listPendingOriginAttempts();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ serialNumber: SN, ip: NEW_IP, deviceName: "البصمة الرئيسية" });
  });

  it("العنوان المخزَّن يبقى مقبولاً بلا أيّ قرينة (لا انحدار على المسار الطبيعي)", async () => {
    const t = await reg(OLD_IP);
    expect(t.sent[0]).toMatchObject({ ret: "reg", result: true });
    expect(await db().select().from(s.hrDeviceOriginAttempts)).toHaveLength(0);
  });
});

describe("ث٥/ث٦ — حدود التلقائية", () => {
  it("الربط الصريح في .env يغلب: لا اعتماد تلقائيّ ولو توفّرت القرينة", async () => {
    process.env.HR_DEVICE_IDENTITY_BINDINGS = JSON.stringify({
      [SN]: { allowlist: [`${OLD_IP}/32`] },
    });
    await seedWitnesses(NEW_IP, [1, 4]);
    const t = await reg(NEW_IP);
    expect(t.sent[0]).toMatchObject({ ret: "reg", result: false });
    expect((await deviceRow()).ip).toBe(OLD_IP);
    expect(await listPendingOriginAttempts()).toHaveLength(1);
  });

  it("مفتاح الإيقاف يُعطّل الاعتماد التلقائيّ ويُبقي الرصد", async () => {
    process.env.HR_DEVICE_ORIGIN_AUTOTRUST = "0";
    expect(resolveOriginTrustConfig().autoTrust).toBe(false);
    await seedWitnesses(NEW_IP, [1, 4]);
    const t = await reg(NEW_IP);
    expect(t.sent[0]).toMatchObject({ ret: "reg", result: false });
    expect((await deviceRow()).ip).toBe(OLD_IP);
    expect(await listPendingOriginAttempts()).toHaveLength(1); // الرؤية تبقى
  });

  it("الافتراضي مُفعَّل — الغرض إنهاء التدخّل اليدويّ، والإيقاف قرارٌ صريح", () => {
    delete process.env.HR_DEVICE_ORIGIN_AUTOTRUST;
    expect(resolveOriginTrustConfig().autoTrust).toBe(true);
    expect(resolveOriginTrustConfig().windowHours).toBe(12);
    expect(resolveOriginTrustConfig().minWitnesses).toBe(2);
  });
});

/* ── ثوابت أضافتها المراجعة العدائية ─────────────────────────────────────── */

describe("ث٧ — المصدر المحجوب عند البوّابة الأولى يظهر في الطابور", () => {
  it("يُرصَد بلا رقم تسلسليّ (وإلّا بقيت حالةُ «لا قرينة» بلا أثرٍ مرئيّ إطلاقاً)", async () => {
    resetBlockedOriginThrottleForTest();
    await recordBlockedOrigin(NEW_IP);
    const pending = await listPendingOriginAttempts();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ ip: NEW_IP, serialNumber: "", decision: "NETWORK_BLOCKED", deviceId: null });
  });

  it("مخنوقٌ في الذاكرة: إلحاح الجهاز (٥ مرّات/ثانية) لا يكتب صفاً لكل محاولة", async () => {
    resetBlockedOriginThrottleForTest();
    for (let i = 0; i < 25; i += 1) await recordBlockedOrigin(NEW_IP);
    const rows = await db().select().from(s.hrDeviceOriginAttempts);
    expect(rows).toHaveLength(1);
    expect(rows[0].attemptCount).toBe(1); // كُتب مرّة واحدة فعلاً — لا ٢٥
  });
});

describe("ث٨ — الاعتماد لا يخرق ثابت الهوية العامّ", () => {
  it("عنوانٌ يملكه جهازٌ مُفعَّلٌ آخر بلا مفتاح ⇒ يُرفض التبنّي (وإلّا سقطت الأجهزة كلّها)", async () => {
    await db().insert(s.hrFingerprintDevices).values({
      id: 11,
      name: "جهاز ثانٍ",
      serialNumber: "ZXRBORIGIN02",
      protocol: "AIFACE_WS",
      branchId: 1,
      enabled: true,
      migrated: true,
      ip: NEW_IP, // العنوان الذي سيحاول جهازنا تبنّيه
    });
    await seedWitnesses(NEW_IP, [1, 4]);

    const t = await reg(NEW_IP);
    expect(t.sent[0]).toMatchObject({ ret: "reg", result: false });
    expect((await deviceRow()).ip).toBe(OLD_IP); // لم يُمسّ

    const rows = await db().select().from(s.hrDeviceOriginAttempts);
    expect(rows.some((r) => r.decision === "WOULD_CONFLICT")).toBe(true);
  });
});

describe("ث٩ — التعديل الجزئيّ لا يمسح ما لم يُرسَل", () => {
  it("تعديل الاسم وحده يُبقي بيانات الهجرة والعدّادات الحيّة", async () => {
    await db()
      .update(s.hrFingerprintDevices)
      .set({
        serverHost: "hr.alarabiya.online",
        serverPort: 7788,
        usersCount: 63,
        recordsCount: 37206,
        firmware: "AiF43H_v1.21",
        status: "online",
      })
      .where(eq(s.hrFingerprintDevices.id, 10));

    await updateDevice(10, { name: "البصمة — المدخل" } as Parameters<typeof updateDevice>[1]);

    const row = await deviceRow();
    expect(row.name).toBe("البصمة — المدخل");
    expect(row.serverHost).toBe("hr.alarabiya.online");
    expect(row.serverPort).toBe(7788);
    expect(row.usersCount).toBe(63);
    expect(row.recordsCount).toBe(37206);
    expect(row.firmware).toBe("AiF43H_v1.21");
    expect(row.status).toBe("online");
    expect(row.ip).toBe(OLD_IP); // لم يُرسَل ⇒ لم يُمسّ
  });

  it("تعديل العنوان صراحةً يكتبه (المسار الذي كان مستحيلاً من الشاشة)", async () => {
    await updateDevice(10, { name: "البصمة الرئيسية", ip: NEW_IP } as Parameters<typeof updateDevice>[1]);
    expect((await deviceRow()).ip).toBe(NEW_IP);
  });
});
