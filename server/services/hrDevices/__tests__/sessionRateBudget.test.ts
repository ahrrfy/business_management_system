// ميزانية رسائل الجلسة المُصادَقة — فصلُها عن ميزانية الاتصال (رُصد حيّاً ١١/٨/٢٦).
//
// الواقعة: بعد عودة جهاز البصمة من انقطاعٍ دام ٨ ساعات، رفع متراكمه دفعاتٍ من ٢٠ بصمة عدّة
// مرّاتٍ في الثانية، فتجاوز الحدّ (٢٤٠/دقيقة) فأُغلق مقبسه — ثمّ **مُنع من إعادة الاتصال**
// لأنّ ترقية WebSocket كانت تشرب من العدّاد المستنزَف نفسه:
//   "تجاوز حد رسائل WebSocket" ثمّ "authorized":true,"withinRate":false ⇒ "رفض ترقية"
// أي أنّ تفريغاً مشروعاً كان يحجب نفسه دورةً بعد دورة حتى انقضاء نافذة الدقيقة.
//
// الثوابت المحروسة:
//   ر١) رسائل جلسةٍ مُصادَقة **لا تستهلك** ميزانية الاتصال ⇒ إعادة الاتصال تبقى ممكنة فوراً.
//   ر٢) الجلسة المُصادَقة تحتمل تفريغاً كثيفاً ضمن ميزانيتها السخيّة.
//   ر٣) ما قبل `reg` يبقى على الميزانية الصارمة — لا تخفيف لمجهولٍ لم يُثبت هويّته.
//   ر٤) السقف يبقى قائماً: جهازٌ معطوبٌ يتجاوز الميزانية السخيّة يُغلَق مقبسه.
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  startHrDeviceBridge,
  type HrDeviceBridge,
  type HrDeviceBridgeStartOptions,
} from "../bridge";
import { resolveBridgeSecurityConfig } from "../bridgeSecurity";

let bridge: HrDeviceBridge | null = null;
const original = {
  host: process.env.HR_DEVICE_HOST,
  allowlist: process.env.HR_DEVICE_IP_ALLOWLIST,
  secret: process.env.HR_DEVICE_SHARED_SECRET,
  rate: process.env.HR_DEVICE_RATE_LIMIT_PER_MINUTE,
  sessionRate: process.env.HR_DEVICE_SESSION_RATE_LIMIT_PER_MINUTE,
  controlDatabaseUrl: process.env.CONTROL_DATABASE_URL,
  nodeEnv: process.env.NODE_ENV,
};

const restore = (key: string, value: string | undefined) => {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

beforeEach(() => {
  delete process.env.CONTROL_DATABASE_URL;
});

afterEach(async () => {
  await bridge?.stop();
  bridge = null;
  restore("HR_DEVICE_HOST", original.host);
  restore("HR_DEVICE_IP_ALLOWLIST", original.allowlist);
  restore("HR_DEVICE_SHARED_SECRET", original.secret);
  restore("HR_DEVICE_RATE_LIMIT_PER_MINUTE", original.rate);
  restore("HR_DEVICE_SESSION_RATE_LIMIT_PER_MINUTE", original.sessionRate);
  restore("NODE_ENV", original.nodeEnv);
});

/** جلسة مزيّفة تُبلّغ «مُسجَّلة» أو لا — البوّابة تختار الميزانية بناءً على `device()`. */
function stubSession(registered: boolean, seen: { count: number }) {
  return () => ({
    handleMessage: async () => {
      seen.count += 1;
    },
    handleClose: async () => undefined,
    device: () => (registered ? ({ id: 1 } as never) : null),
  });
}

async function startBridge(options: HrDeviceBridgeStartOptions): Promise<number> {
  process.env.HR_DEVICE_HOST = "127.0.0.1";
  process.env.HR_DEVICE_IP_ALLOWLIST = "127.0.0.1";
  process.env.HR_DEVICE_SHARED_SECRET = "test-gateway-secret-value-01";
  bridge = await startHrDeviceBridge(0, options);
  const address = bridge.server.address();
  if (!address || typeof address === "string") throw new Error("no TCP bind");
  return address.port;
}

function connect(port: number): WebSocket {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/?token=test-gateway-secret-value-01`);
  socket.on("error", () => undefined);
  return socket;
}

/** ينتظر وصول عدّاد الرسائل المُعالَجة إلى الهدف (المعالجة متسلسلة وغير متزامنة). */
async function waitFor(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("WAIT_TIMEOUT");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("ر١/ر٢ — تفريغ المتراكم لا يحجب إعادة الاتصال", () => {
  it("جلسة مُصادَقة ترسل أضعاف ميزانية الاتصال، ويبقى الاتصال التالي مقبولاً", async () => {
    // ميزانية اتصالٍ ضيّقة عمداً (٥) وميزانية جلسةٍ سخيّة — لو تشاركا العدّاد لاستُنزف فوراً.
    process.env.HR_DEVICE_RATE_LIMIT_PER_MINUTE = "10";
    process.env.HR_DEVICE_SESSION_RATE_LIMIT_PER_MINUTE = "500";
    const seen = { count: 0 };
    const port = await startBridge({ sessionFactory: stubSession(true, seen) });

    const socket = connect(port);
    await once(socket, "open");
    for (let i = 0; i < 120; i += 1) socket.send(`{"cmd":"sendlog","n":${i}}`);
    await waitFor(() => seen.count >= 120);
    expect(socket.readyState).toBe(WebSocket.OPEN); // لم يُغلَق: ضمن ميزانية الجلسة
    socket.close();

    // ⭐ الثابت الحاكم: ١٢٠ رسالة لم تمسّ ميزانية الاتصال (١٠) ⇒ الترقية التالية تنجح.
    const reconnect = connect(port);
    await expect(once(reconnect, "open")).resolves.toBeDefined();
    reconnect.close();
  });
});

describe("ر٣ — لا تخفيف قبل إثبات الهوية", () => {
  it("جلسة غير مُسجَّلة تبقى على الميزانية الصارمة ويُغلَق مقبسها عند تجاوزها", async () => {
    process.env.HR_DEVICE_RATE_LIMIT_PER_MINUTE = "10";
    process.env.HR_DEVICE_SESSION_RATE_LIMIT_PER_MINUTE = "5000";
    const seen = { count: 0 };
    const port = await startBridge({ sessionFactory: stubSession(false, seen) });

    const socket = connect(port);
    await once(socket, "open");
    for (let i = 0; i < 60; i += 1) socket.send(`{"cmd":"reg","n":${i}}`);
    await once(socket, "close"); // الميزانية الصارمة أغلقته رغم سخاء ميزانية الجلسة
    expect(seen.count).toBeLessThan(60);
  });
});

describe("ر٤ — السقف يبقى قائماً", () => {
  it("جلسة مُصادَقة تتجاوز ميزانيتها السخيّة يُغلَق مقبسها (حماية من جهازٍ معطوب)", async () => {
    process.env.HR_DEVICE_RATE_LIMIT_PER_MINUTE = "10000";
    process.env.HR_DEVICE_SESSION_RATE_LIMIT_PER_MINUTE = "60"; // الحدّ الأدنى المسموح
    const seen = { count: 0 };
    const port = await startBridge({ sessionFactory: stubSession(true, seen) });

    const socket = connect(port);
    await once(socket, "open");
    for (let i = 0; i < 200; i += 1) socket.send(`{"cmd":"sendlog","n":${i}}`);
    await once(socket, "close");
    expect(seen.count).toBeLessThan(200);
  });

  it("الإعداد محدود بحدّين ويُردّ إلى الافتراضي عند قيمةٍ خارجة", () => {
    process.env.HR_DEVICE_SESSION_RATE_LIMIT_PER_MINUTE = "0";
    expect(resolveBridgeSecurityConfig().maxSessionMessagesPerMinute).toBe(3_000);
    process.env.HR_DEVICE_SESSION_RATE_LIMIT_PER_MINUTE = "999999999";
    expect(resolveBridgeSecurityConfig().maxSessionMessagesPerMinute).toBe(3_000);
    process.env.HR_DEVICE_SESSION_RATE_LIMIT_PER_MINUTE = "1200";
    expect(resolveBridgeSecurityConfig().maxSessionMessagesPerMinute).toBe(1_200);
  });

  it("الافتراضي سخيٌّ بما يكفي لتفريغٍ واقعيّ وأعلى بكثير من ميزانية الاتصال", () => {
    delete process.env.HR_DEVICE_SESSION_RATE_LIMIT_PER_MINUTE;
    delete process.env.HR_DEVICE_RATE_LIMIT_PER_MINUTE;
    const cfg = resolveBridgeSecurityConfig();
    expect(cfg.maxSessionMessagesPerMinute).toBe(3_000);
    expect(cfg.maxSessionMessagesPerMinute).toBeGreaterThan(cfg.maxRequestsPerMinute);
  });
});
