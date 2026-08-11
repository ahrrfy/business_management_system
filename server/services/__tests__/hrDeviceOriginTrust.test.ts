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
  resolveOriginTrustConfig,
} from "../hrDevices/originTrust";
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

  it("التعلُّم يجمع عنوان الجهاز المُفعَّل + عنوان جلسة موظّف فرعه", async () => {
    await seedSession({ userId: 1, ip: NEW_IP });
    const learned = await loadLearnedOrigins(WINDOW_HOURS);
    expect(learned.has(OLD_IP)).toBe(true); // عنوان الجهاز المخزَّن
    expect(learned.has(NEW_IP)).toBe(true); // العنوان الجديد من جلسة الموظّف
  });
});

describe("ث٢ — القرينة صادقة", () => {
  it("جلسة حيّة لموظّف فرع الجهاز تُعزّز", async () => {
    await seedSession({ userId: 1, ip: NEW_IP });
    await expect(isOriginCorroborated(1, NEW_IP, WINDOW_HOURS)).resolves.toBe(true);
  });

  it("جلسة ملغاة أو منتهية أو راكدة لا تُعزّز", async () => {
    await seedSession({ userId: 1, ip: NEW_IP, revoked: true });
    await expect(isOriginCorroborated(1, NEW_IP, WINDOW_HOURS)).resolves.toBe(false);

    await truncateTables(["userSessions"]);
    await seedSession({ userId: 1, ip: NEW_IP, expiresInMs: -1000 });
    await expect(isOriginCorroborated(1, NEW_IP, WINDOW_HOURS)).resolves.toBe(false);

    await truncateTables(["userSessions"]);
    await seedSession({ userId: 1, ip: NEW_IP, lastSeenAgoMs: 24 * 3600_000 });
    await expect(isOriginCorroborated(1, NEW_IP, WINDOW_HOURS)).resolves.toBe(false);
  });

  it("جلسة موظّفٍ من فرعٍ آخر أو موظّفٍ معطَّل لا تُعزّز فرع الجهاز", async () => {
    await seedSession({ userId: 2, ip: NEW_IP });
    await seedSession({ userId: 3, ip: NEW_IP });
    await expect(isOriginCorroborated(1, NEW_IP, WINDOW_HOURS)).resolves.toBe(false);
  });

  it("صيغة IPv4 المُغلَّفة في الجلسة تطابق الصيغة المجرّدة التي يراها الجسر", async () => {
    await seedSession({ userId: 1, ip: `::ffff:${NEW_IP}` });
    await expect(isOriginCorroborated(1, NEW_IP, WINDOW_HOURS)).resolves.toBe(true);
  });
});

describe("ث٣/ث٤ — الاعتماد التلقائي والرصد", () => {
  it("عنوانٌ جديد مُعزَّز ⇒ يُقبل التسجيل ويُحدَّث عنوان الجهاز وتُحسم المحاولة تلقائياً", async () => {
    await seedSession({ userId: 1, ip: NEW_IP });
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
    await seedSession({ userId: 1, ip: NEW_IP });
    const t = await reg(NEW_IP);
    expect(t.sent[0]).toMatchObject({ ret: "reg", result: false });
    expect((await deviceRow()).ip).toBe(OLD_IP);
    expect(await listPendingOriginAttempts()).toHaveLength(1);
  });

  it("مفتاح الإيقاف يُعطّل الاعتماد التلقائيّ ويُبقي الرصد", async () => {
    process.env.HR_DEVICE_ORIGIN_AUTOTRUST = "0";
    expect(resolveOriginTrustConfig().autoTrust).toBe(false);
    await seedSession({ userId: 1, ip: NEW_IP });
    const t = await reg(NEW_IP);
    expect(t.sent[0]).toMatchObject({ ret: "reg", result: false });
    expect((await deviceRow()).ip).toBe(OLD_IP);
    expect(await listPendingOriginAttempts()).toHaveLength(1); // الرؤية تبقى
  });

  it("الافتراضي مُفعَّل — الغرض إنهاء التدخّل اليدويّ، والإيقاف قرارٌ صريح", () => {
    delete process.env.HR_DEVICE_ORIGIN_AUTOTRUST;
    expect(resolveOriginTrustConfig().autoTrust).toBe(true);
    expect(resolveOriginTrustConfig().windowHours).toBe(12);
  });
});
