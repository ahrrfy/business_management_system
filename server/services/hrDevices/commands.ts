/* ============================================================================
 * طابور أوامر الخادم→الجهاز (server/services/hrDevices/commands.ts)
 * الجهاز خلف NAT يبادر بالاتصال ⇒ الأوامر تُصفّ في hrDeviceCommands وتُدفع إليه
 * لحظة توفر وصلة حية (aiface) أو عند نبضة getrequest (iclock). أمر واحد قيد
 * التنفيذ لكل جهاز — البروتوكول طلب/استجابة متسلسل على مقبس واحد.
 * ========================================================================== */
import { and, asc, eq, sql } from "drizzle-orm";
import { hrDeviceCommands } from "../../../drizzle/schema";
import { requireDb } from "../tx";
import { logger } from "../../logger";
import { getLink } from "./registry";
import type { DeviceCommandName, DeviceLink } from "./types";
import { DEVICE_COMMANDS, baghdadNow } from "./types";

/** الأوامر المدعومة لكل بروتوكول — iclock النصي يدعم رقعة أضيق حالياً (تتوسع مع جهاز حقيقي). */
export const PROTOCOL_COMMANDS: Record<string, readonly DeviceCommandName[]> = {
  AIFACE_WS: DEVICE_COMMANDS,
  ZKTECO_PUSH: ["getnewlog", "getalllog", "reboot"],
};

export async function enqueueCommand(
  deviceId: number,
  cmd: DeviceCommandName,
  payload: Record<string, unknown> | null,
  createdBy: number | null
): Promise<number> {
  const db = requireDb();
  const [res] = await db.insert(hrDeviceCommands).values({
    deviceId,
    cmd,
    payload: payload ?? null,
    status: "queued",
    createdBy,
  });
  const id = Number((res as { insertId?: number }).insertId ?? 0);
  // إن كان الجهاز متصلاً الآن (aiface) ندفع فوراً — وإلا تلتقطه نبضته القادمة.
  pumpCommands(deviceId);
  return id;
}

/** رسالة aiface السلكية لأمر مصفوف. */
export function buildAifaceCommand(cmd: string, payload: unknown): Record<string, unknown> {
  const p = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  switch (cmd) {
    case "settime":
      return { cmd, cloudtime: baghdadNow() };
    case "getalllog":
    case "getnewlog":
    case "getuserlist":
      return { cmd, stn: true };
    case "getuserinfo":
      return { cmd, enrollid: p.enrollid, backupnum: p.backupnum ?? 0 };
    default:
      return { cmd, ...p };
  }
}

/** دفع الأمر التالي لجهاز متصل (aiface) — تُستدعى بعد التسجيل وبعد اكتمال كل أمر. */
export function pumpCommands(deviceId: number): void {
  const link = getLink(deviceId);
  if (!link || link.inflight) return;
  void (async () => {
    const db = requireDb();
    // ادّعاء ذرّي: قد يتسابق نداءان (enqueue متتاليان) فيختاران نفس الصفّ الأقدم. المطالبة
    // بـUPDATE مشروط status='queued' تضمن فائزاً واحداً (affectedRows=1) فلا يُرسَل أمرٌ مرتين.
    for (let guard = 0; guard < 50; guard++) {
      if (link.inflight) return; // فاز ادّعاء متزامن آخر بينما ننتظر
      const [next] = await db
        .select()
        .from(hrDeviceCommands)
        .where(and(eq(hrDeviceCommands.deviceId, deviceId), eq(hrDeviceCommands.status, "queued")))
        .orderBy(asc(hrDeviceCommands.id))
        .limit(1);
      if (!next) return;
      const res = await db
        .update(hrDeviceCommands)
        .set({ status: "sent", sentAt: sql`CURRENT_TIMESTAMP` })
        .where(and(eq(hrDeviceCommands.id, next.id), eq(hrDeviceCommands.status, "queued")));
      const claimed = (res as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 0;
      if (claimed !== 1) continue; // خسر السباق على هذا الصفّ — جرّب التالي
      link.inflight = { commandId: next.id, cmd: next.cmd, received: 0, expected: null };
      link.send(buildAifaceCommand(next.cmd, next.payload));
      logger.info({ deviceId, cmd: next.cmd, commandId: next.id }, "hrDevices: أمر أُرسل للجهاز");
      return;
    }
  })().catch((e) => logger.error({ err: e, deviceId }, "hrDevices: فشل دفع أمر"));
}

/** إتمام الأمر الجاري على وصلة (نجاحاً أو فشلاً) ثم دفع التالي. */
export async function completeInflight(
  link: DeviceLink,
  ok: boolean,
  result: unknown,
  error?: string
): Promise<void> {
  const inflight = link.inflight;
  if (!inflight) return;
  link.inflight = null;
  const db = requireDb();
  await db
    .update(hrDeviceCommands)
    .set({
      status: ok ? "done" : "failed",
      result: result ?? null,
      error: error ?? null,
      doneAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(hrDeviceCommands.id, inflight.commandId));
  pumpCommands(link.deviceId);
}

/** انقطاع الوصلة والأمر جارٍ ⇒ يعود queued ليُعاد إرساله عند الاتصال التالي (لا أمر يضيع). */
export async function requeueInflight(link: DeviceLink): Promise<void> {
  const inflight = link.inflight;
  if (!inflight) return;
  link.inflight = null;
  const db = requireDb();
  await db
    .update(hrDeviceCommands)
    .set({ status: "queued", sentAt: null })
    .where(and(eq(hrDeviceCommands.id, inflight.commandId), eq(hrDeviceCommands.status, "sent")));
}

/**
 * اتصال aiface جديد = لا ردّ قادم لأي أمر sent سابق (المقبس القديم مات أو العملية أُعيد تشغيلها)
 * ⇒ تُعاد كلها queued فتُرسل من جديد. لا تُستدعى لمسار iclock (ردّه يأتي بطلب HTTP مستقل).
 */
export async function requeueStaleSentCommands(deviceId: number): Promise<void> {
  const db = requireDb();
  await db
    .update(hrDeviceCommands)
    .set({ status: "queued", sentAt: null })
    .where(and(eq(hrDeviceCommands.deviceId, deviceId), eq(hrDeviceCommands.status, "sent")));
}

/** iclock: التقاط الأمر التالي عند نبضة getrequest (يُوسَم sent فوراً — الرد يأتي عبر devicecmd). */
export async function popIclockCommand(
  deviceId: number
): Promise<{ id: number; cmd: string } | null> {
  const db = requireDb();
  // ادّعاء ذرّي مطابق لـpumpCommands: نبضتا getrequest متزامنتان لا تلتقطان نفس الأمر مرتين.
  for (let guard = 0; guard < 50; guard++) {
    const [next] = await db
      .select({ id: hrDeviceCommands.id, cmd: hrDeviceCommands.cmd })
      .from(hrDeviceCommands)
      .where(and(eq(hrDeviceCommands.deviceId, deviceId), eq(hrDeviceCommands.status, "queued")))
      .orderBy(asc(hrDeviceCommands.id))
      .limit(1);
    if (!next) return null;
    const res = await db
      .update(hrDeviceCommands)
      .set({ status: "sent", sentAt: sql`CURRENT_TIMESTAMP` })
      .where(and(eq(hrDeviceCommands.id, next.id), eq(hrDeviceCommands.status, "queued")));
    const claimed = (res as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 0;
    if (claimed === 1) return next;
  }
  return null;
}

/** iclock: إتمام أمر بمعرّفه من ردّ devicecmd (Return=0 نجاح). */
export async function completeIclockCommand(commandId: number, returnCode: number): Promise<void> {
  const db = requireDb();
  await db
    .update(hrDeviceCommands)
    .set({
      status: returnCode === 0 ? "done" : "failed",
      result: { returnCode },
      error: returnCode === 0 ? null : `الجهاز أعاد رمز ${returnCode}`,
      doneAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(hrDeviceCommands.id, commandId));
}
