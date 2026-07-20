/* ============================================================================
 * سائق عائلة ZKTeco PUSH/iclock (server/services/hrDevices/iclockDriver.ts)
 * البروتوكول النصي المهيمن في أجهزة الحضور العراقية (ZKTeco وأشباهها): الجهاز
 * يبادر بطلبات HTTP — GET /iclock/cdata (مصافحة)، POST /iclock/cdata (سجلات
 * ATTLOG/OPERLOG أسطراً مفصولة بتاب)، GET /iclock/getrequest (نبض + التقاط أوامر)،
 * POST /iclock/devicecmd (نتائج الأوامر). يعمل على نفس منفذ الجسر مع WebSocket.
 * ========================================================================== */
import type { IncomingMessage, ServerResponse } from "http";
import { logger } from "../../logger";
import { foldSoon } from "./attendanceFold";
import { completeIclockCommand, popIclockCommand } from "./commands";
import { resolveDeviceBySn, touchDevice } from "./registry";
import { ingestPunches, upsertDeviceUser } from "./punchStore";
import type { RawPunch } from "./types";

const MAX_BODY = 8 * 1024 * 1024; // دفعة سجلات كبيرة بعد انقطاع طويل — 8م.ب سقف كافٍ وآمن

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendText(res: ServerResponse, body: string): void {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(body);
}

/** ATTLOG: أسطر `PIN\tYYYY-MM-DD HH:MM:SS\tstatus\tverify...` — status: 0 دخول 1 خروج. */
export function parseAttlog(body: string): RawPunch[] {
  const verifyMap: Record<number, string> = { 1: "fp", 15: "face", 3: "card", 4: "card", 0: "pwd" };
  const out: RawPunch[] = [];
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const cols = t.split("\t");
    if (cols.length < 2) continue;
    const enrollId = Number(cols[0]);
    const status = Number(cols[2]);
    const verify = Number(cols[3]);
    out.push({
      enrollId,
      punchAt: cols[1],
      mode: Number.isFinite(verify) ? (verifyMap[verify] ?? String(verify)) : undefined,
      inOut: status === 0 ? "in" : status === 1 ? "out" : undefined,
      raw: { line: t },
    });
  }
  return out;
}

/** OPERLOG: نلتقط أسطر `USER PIN=..\tName=..\tPri=..\tCard=..` (تسجيل مستخدمين على الجهاز). */
export function parseOperlogUsers(body: string): Array<{ enrollId: number; name?: string; isAdmin?: boolean; cardNo?: string }> {
  const out: Array<{ enrollId: number; name?: string; isAdmin?: boolean; cardNo?: string }> = [];
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("USER ")) continue;
    const fields = new Map<string, string>();
    for (const part of t.slice(5).split("\t")) {
      const i = part.indexOf("=");
      if (i > 0) fields.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
    }
    const pin = Number(fields.get("PIN"));
    if (!Number.isInteger(pin)) continue;
    out.push({
      enrollId: pin,
      name: fields.get("Name") || undefined,
      isAdmin: Number(fields.get("Pri") ?? 0) > 0,
      cardNo: fields.get("Card") || undefined,
    });
  }
  return out;
}

/** أمر مصفوف → صيغة سلك iclock. */
export function formatIclockCommand(id: number, cmd: string): string {
  switch (cmd) {
    case "getnewlog":
      return `C:${id}:CHECK`;
    case "getalllog":
      return `C:${id}:DATA QUERY ATTLOG`;
    case "reboot":
      return `C:${id}:REBOOT`;
    default:
      return "OK";
  }
}

/** ردّ المصافحة: يطلب الإرسال الفوري (Realtime=1) وكل السجلات غير المرحَّلة (Stamp=None). */
function registryOptions(sn: string): string {
  return [
    `GET OPTION FROM: ${sn}`,
    "ATTLOGStamp=None",
    "OPERLOGStamp=9999",
    "ATTPHOTOStamp=None",
    "ErrorDelay=30",
    "Delay=10",
    "TransTimes=00:00;12:00",
    "TransInterval=1",
    "TransFlag=1111000000",
    "TimeZone=3",
    "Realtime=1",
    "Encrypt=None",
  ].join("\n");
}

/** المدخل الوحيد: يعالج طلبات /iclock/* — يعيد true إن كان المسار له. */
export async function handleIclock(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://device.local");
  if (!url.pathname.startsWith("/iclock/")) return false;
  const sn = (url.searchParams.get("SN") ?? "").trim();
  try {
    if (!sn) {
      sendText(res, "OK");
      return true;
    }
    const device = await resolveDeviceBySn(sn, "ZKTECO_PUSH");
    if (!device || !device.enabled) {
      // غير معتمد: ردّ محايد بلا إعدادات — لا يُقبل منه شيء حتى يعتمده المدير.
      sendText(res, "OK");
      return true;
    }

    if (url.pathname === "/iclock/cdata" && req.method === "GET") {
      await touchDevice(device.id, { handshake: true });
      sendText(res, registryOptions(sn));
      return true;
    }

    if (url.pathname === "/iclock/cdata" && req.method === "POST") {
      const table = url.searchParams.get("table") ?? "";
      const body = await readBody(req);
      if (table === "ATTLOG") {
        const punches = parseAttlog(body);
        const { accepted, lastPunchAt } = await ingestPunches(device, punches);
        await touchDevice(device.id, lastPunchAt ? { lastPunchAt } : {});
        if (accepted > 0) foldSoon();
        sendText(res, `OK: ${punches.length}`);
        return true;
      }
      if (table === "OPERLOG") {
        const users = parseOperlogUsers(body);
        for (const u of users) await upsertDeviceUser(device, u);
        await touchDevice(device.id);
        sendText(res, `OK: ${users.length}`);
        return true;
      }
      await touchDevice(device.id);
      sendText(res, "OK");
      return true;
    }

    if (url.pathname === "/iclock/getrequest" && req.method === "GET") {
      await touchDevice(device.id);
      const next = await popIclockCommand(device.id);
      sendText(res, next ? formatIclockCommand(next.id, next.cmd) : "OK");
      return true;
    }

    if (url.pathname === "/iclock/devicecmd" && req.method === "POST") {
      const body = await readBody(req);
      // صيغة: ID=5&Return=0&CMD=CHECK — وقد تصل عدة أسطر.
      for (const line of body.split(/\r?\n/)) {
        const m = /ID=(\d+).*?Return=(-?\d+)/.exec(line);
        if (m) await completeIclockCommand(Number(m[1]), Number(m[2]));
      }
      await touchDevice(device.id);
      sendText(res, "OK");
      return true;
    }

    sendText(res, "OK");
    return true;
  } catch (e) {
    logger.error({ err: e, sn, path: url.pathname }, "hrDevices/iclock: فشل معالجة طلب");
    // ردّ محايد كي لا يدخل الجهاز في حلقة إعادة محاولة عدوانية.
    if (!res.headersSent) sendText(res, "OK");
    return true;
  }
}
