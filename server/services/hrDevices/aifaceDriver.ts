/* ============================================================================
 * سائق عائلة AiFace/AI518 (server/services/hrDevices/aifaceDriver.ts)
 * البروتوكول: JSON عبر WebSocket، الجهاز عميل يبادر. رسائل الجهاز تحمل "cmd"
 * (reg/sendlog/senduser...) وردودنا تحمل "ret"؛ أوامرنا تحمل "cmd" ورد الجهاز
 * عليها يحمل "ret" مطابقاً. مبني transport-agnostic (دالة إرسال مُمرَّرة) ليُختبر
 * بلا مقابس حقيقية، وليُثبَّت على التقاط أول مصافحة حية من جهاز المالك.
 * ========================================================================== */
import { logger } from "../../logger";
import { foldSoon } from "./attendanceFold";
import { completeInflight, pumpCommands, requeueInflight, requeueStaleSentCommands } from "./commands";
import {
  enabledDeviceIdentityRuntimeFailure,
  registerLink,
  removeLink,
  resolveDeviceBySn,
  touchDevice,
} from "./registry";
import { ingestPunches, upsertDeviceUser } from "./punchStore";
import type { DeviceLink, DeviceRow, RawPunch } from "./types";
import { baghdadNow } from "./types";
import {
  authorizeDeviceIdentity,
  normalizeRemoteAddress,
  resolveBridgeSecurityConfig,
  type BridgeSecurityConfig,
} from "./bridgeSecurity";
import { tryAutoAdoptOrigin } from "./originTrust";

export interface AifaceTransport {
  sendText: (text: string) => void;
  close: () => void;
  remote?: string;
  deviceCredential?: string;
  securityConfig?: BridgeSecurityConfig;
}

export interface AifaceSession {
  handleMessage: (text: string) => Promise<void>;
  handleClose: () => Promise<void>;
  /** للجسر/الاختبارات: الجهاز المسجَّل على هذه الجلسة (بعد reg الناجح). */
  device: () => DeviceRow | null;
}

/** وسيلة التحقق المُبلَّغة رقمياً → وسم مفهوم حيث نثق بالخريطة، وإلا الرقم نصاً (صدق لا تخمين). */
function modeLabel(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  const known: Record<number, string> = { 0: "fp", 1: "fp", 2: "card", 3: "card", 8: "face", 15: "face" };
  return Number.isFinite(n) ? (known[n] ?? String(n)) : String(v).slice(0, 12);
}

function inOutLabel(v: unknown): string | undefined {
  const n = Number(v);
  if (n === 0) return "in";
  if (n === 1) return "out";
  return undefined;
}

function toRawPunches(records: unknown): RawPunch[] {
  if (!Array.isArray(records)) return [];
  const out: RawPunch[] = [];
  for (const r of records) {
    if (!r || typeof r !== "object") continue;
    const rec = r as Record<string, unknown>;
    out.push({
      enrollId: Number(rec.enrollid),
      punchAt: String(rec.time ?? ""),
      mode: modeLabel(rec.mode),
      inOut: inOutLabel(rec.inout),
      raw: rec,
    });
  }
  return out;
}

/** عدادات devinfo تأتي بأسماء متفاوتة بين إصدارات الفيرموير — نلتقط أول موجود. */
function pickNumber(o: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = Number(o[k]);
    if (Number.isFinite(v) && v >= 0) return v;
  }
  return undefined;
}

export function createAifaceSession(transport: AifaceTransport): AifaceSession {
  let device: DeviceRow | null = null;
  let link: DeviceLink | null = null;
  const securityConfig = transport.securityConfig ?? resolveBridgeSecurityConfig();

  const send = (obj: Record<string, unknown>) => {
    try {
      transport.sendText(JSON.stringify(obj));
    } catch (e) {
      logger.warn({ err: e }, "hrDevices/aiface: فشل إرسال");
    }
  };

  async function onReg(msg: Record<string, unknown>): Promise<void> {
    const sn = String(msg.sn ?? "").trim();
    const validSn = /^[A-Za-z0-9._:-]{1,64}$/.test(sn);
    let row = validSn ? await resolveDeviceBySn(sn, "AIFACE_WS", transport.remote) : null;
    if (!row || !row.enabled) {
      // مجهول أو غير معتمد: يُرفض التسجيل (الصف أُنشئ معطَّلاً ليعتمده المدير من الشاشة).
      send({ ret: "reg", result: false, reason: 1 });
      logger.warn({ sn, remote: transport.remote }, "hrDevices/aiface: رفض تسجيل جهاز غير معتمد");
      transport.close();
      return;
    }
    const runtimeIdentityFailure = await enabledDeviceIdentityRuntimeFailure(securityConfig);
    if (runtimeIdentityFailure) {
      send({ ret: "reg", result: false, reason: 2 });
      logger.error({ decision: "IDENTITY_PREFLIGHT_FAILED" }, "hrDevices/aiface: تدقيق هوية الأجهزة غير جاهز");
      transport.close();
      return;
    }
    const identityContext = {
      remoteAddress: transport.remote,
      credential: transport.deviceCredential ?? "",
    };
    let identity = authorizeDeviceIdentity(row, sn, identityContext, securityConfig);
    if (!identity.authorized) {
      // «العنوان يُتعلَّم لا يُكتَب»: مزوّد الإنترنت يغيّر عنوان المتجر دورياً، فلا يجوز أن
      // يكون التعافي SSHاً وتعديلاً يدوياً. نعتمد العنوان الجديد **فقط** إن عزّزته جلسةُ
      // موظّفٍ مُصادَقٍ حيّة من الفرع نفسه (راجع originTrust.ts)، ثمّ **نُعيد تمرير البوّابة
      // نفسها** على الصفّ المُحدَّث — لا التفاف عليها ولا ثقةَ مبنيّة على نيّتنا.
      const auto = await tryAutoAdoptOrigin({
        device: { id: row.id, branchId: row.branchId ?? null },
        serialNumber: sn,
        ip: transport.remote ?? "",
        decision: identity.decision,
        security: securityConfig,
      });
      if (auto.adopted) {
        const previousIp = row.ip;
        row = { ...row, ip: normalizeRemoteAddress(transport.remote) };
        identity = authorizeDeviceIdentity(row, sn, identityContext, securityConfig);
        logger.warn(
          { sn, remote: transport.remote, previousIp, reason: auto.reason, decision: identity.decision },
          "hrDevices/aiface: اعتماد تلقائي لعنوان جديد بقرينة جلسة موظّف مُصادَقة",
        );
      }
      if (!identity.authorized) {
        send({ ret: "reg", result: false, reason: 2 });
        logger.warn(
          { sn, remote: transport.remote, decision: identity.decision, autoTrust: auto.reason },
          "hrDevices/aiface: رفض هوية جهاز لا تطابق الربط المعتمد",
        );
        transport.close();
        return;
      }
    }
    if (identity.decision === "LEGACY_MIGRATION") {
      logger.warn({ sn, remote: transport.remote }, "hrDevices/aiface: قبول مؤقت بوضع هجرة الهوية القديمة");
    }
    const devinfo = (msg.devinfo && typeof msg.devinfo === "object" ? msg.devinfo : {}) as Record<string, unknown>;
    device = row;
    link = {
      deviceId: row.id,
      serialNumber: sn,
      protocol: "AIFACE_WS",
      send,
      close: transport.close,
      inflight: null,
    };
    registerLink(link);
    await touchDevice(row.id, {
      handshake: true,
      devInfo: devinfo,
      firmware: typeof devinfo.firmware === "string" ? devinfo.firmware : undefined,
      usersCount: pickNumber(devinfo, ["useduser", "userscount", "usercount"]),
      recordsCount: pickNumber(devinfo, ["usedlog", "logscount", "alllogcount"]),
    });
    // cloudtime في ردّ التسجيل = مزامنة ساعة الجهاز مع الخادم عند كل اتصال (علة الحضور الكلاسيكية).
    send({ ret: "reg", result: true, cloudtime: baghdadNow(), nosenduser: false });
    // اتصال جديد ⇒ أوامر sent السابقة يتيمة (لن يصل ردها) — تُعاد queued ثم تُدفع من جديد.
    await requeueStaleSentCommands(row.id);
    pumpCommands(row.id);
  }

  async function onSendlog(msg: Record<string, unknown>): Promise<void> {
    if (!device) return;
    const punches = toRawPunches(msg.record);
    const { accepted, lastPunchAt } = await ingestPunches(device, punches);
    await touchDevice(device.id, lastPunchAt ? { lastPunchAt } : {});
    send({
      ret: "sendlog",
      result: true,
      count: Number(msg.count ?? punches.length),
      logindex: Number(msg.logindex ?? -1),
      cloudtime: baghdadNow(),
      access: 1,
    });
    if (accepted > 0) foldSoon();
  }

  async function onSenduser(msg: Record<string, unknown>): Promise<void> {
    if (!device) return;
    await upsertDeviceUser(device, {
      enrollId: Number(msg.enrollid),
      name: typeof msg.name === "string" ? msg.name : undefined,
      isAdmin: Number(msg.admin ?? 0) > 0,
      backup:
        msg.backupnum !== undefined ? { num: Number(msg.backupnum), record: msg.record ?? null } : undefined,
    });
    send({ ret: "senduser", result: true, cloudtime: baghdadNow() });
  }

  /** ردود الجهاز على أوامرنا — التجميعية منها (سجلات/مستخدمون) تُبلَع دفعةً-دفعةً بمواصلة stn. */
  async function onCommandReply(msg: Record<string, unknown>): Promise<void> {
    if (!device || !link) return;
    const inflight = link.inflight;
    const ret = String(msg.ret);
    if (!inflight || inflight.cmd !== ret) {
      logger.info({ ret, deviceId: device.id }, "hrDevices/aiface: ردّ بلا أمر جارٍ — تجاهل");
      return;
    }
    if (msg.result === false) {
      await completeInflight(link, false, msg, `الجهاز رفض الأمر ${ret}`);
      return;
    }
    if (ret === "getalllog" || ret === "getnewlog") {
      const punches = toRawPunches(msg.record);
      if (punches.length > 0) {
        const { lastPunchAt } = await ingestPunches(device, punches);
        await touchDevice(device.id, lastPunchAt ? { lastPunchAt } : {});
        foldSoon();
      }
      inflight.received += punches.length;
      const expected = Number(msg.count);
      if (Number.isFinite(expected) && expected >= 0) inflight.expected = expected;
      const more =
        punches.length > 0 &&
        (inflight.expected == null || inflight.received < inflight.expected) &&
        inflight.received < 1_000_000; // صمام أمان ضد فيرموير لا ينهي المواصلة
      if (more) {
        send({ cmd: ret, stn: false });
      } else {
        await completeInflight(link, true, { received: inflight.received });
      }
      return;
    }
    if (ret === "getuserlist") {
      const records = Array.isArray(msg.record) ? msg.record : [];
      for (const r of records) {
        if (!r || typeof r !== "object") continue;
        const rec = r as Record<string, unknown>;
        await upsertDeviceUser(device, {
          enrollId: Number(rec.enrollid),
          name: typeof rec.name === "string" ? rec.name : undefined,
          isAdmin: Number(rec.admin ?? 0) > 0,
        });
      }
      inflight.received += records.length;
      const expected = Number(msg.count);
      if (Number.isFinite(expected) && expected >= 0) inflight.expected = expected;
      const more =
        records.length > 0 &&
        (inflight.expected == null || inflight.received < inflight.expected) &&
        inflight.received < 100_000;
      if (more) {
        send({ cmd: ret, stn: false });
      } else {
        await completeInflight(link, true, { received: inflight.received });
      }
      return;
    }
    if (ret === "getuserinfo") {
      await upsertDeviceUser(device, {
        enrollId: Number(msg.enrollid),
        name: typeof msg.name === "string" ? msg.name : undefined,
        isAdmin: Number(msg.admin ?? 0) > 0,
        backup:
          msg.backupnum !== undefined ? { num: Number(msg.backupnum), record: msg.record ?? null } : undefined,
      });
      await completeInflight(link, true, { enrollid: msg.enrollid, backupnum: msg.backupnum });
      return;
    }
    // البقية (settime/setuserinfo/deleteuser/opendoor/reboot): إتمام مباشر بنتيجة الجهاز.
    const { record: _bulk, ...light } = msg;
    await completeInflight(link, true, light);
  }

  return {
    device: () => device,
    async handleMessage(text: string): Promise<void> {
      let msg: Record<string, unknown>;
      try {
        const parsed = JSON.parse(text) as unknown;
        if (!parsed || typeof parsed !== "object") return;
        msg = parsed as Record<string, unknown>;
        // دفعة غير منطقية قد تحجز الذاكرة/قاعدة البيانات طويلاً؛ إغلاق الوصلة بلا إقرار
        // يجعل الجهاز يعيد إرسالها بعد الاتصال بدلاً من إسقاط سجلات بصمت.
        if (Array.isArray(msg.record) && msg.record.length > 20_000) {
          logger.warn({ count: msg.record.length, remote: transport.remote }, "hrDevices/aiface: دفعة تتجاوز الحد");
          transport.close();
          return;
        }
      } catch {
        logger.warn({ sample: text.slice(0, 120), remote: transport.remote }, "hrDevices/aiface: رسالة غير JSON");
        return;
      }
      try {
        if (typeof msg.cmd === "string") {
          if (msg.cmd === "reg") return await onReg(msg);
          if (!device) {
            // لا شيء قبل تسجيل ناجح — جهاز غير معتمد لا يُسرِّب بصمات.
            send({ ret: msg.cmd, result: false });
            return;
          }
          await touchDevice(device.id);
          if (msg.cmd === "sendlog") return await onSendlog(msg);
          if (msg.cmd === "senduser") return await onSenduser(msg);
          // نبضات/رسائل غير معروفة: إقرار عام حتى لا يعلق الجهاز منتظراً.
          send({ ret: msg.cmd, result: true, cloudtime: baghdadNow() });
          return;
        }
        if (typeof msg.ret === "string") {
          if (device) await touchDevice(device.id);
          return await onCommandReply(msg);
        }
      } catch (e) {
        logger.error({ err: e, cmd: msg.cmd ?? msg.ret }, "hrDevices/aiface: فشل معالجة رسالة");
      }
    },
    async handleClose(): Promise<void> {
      const closingLink = link;
      link = null;
      device = null;
      if (closingLink) {
        // عزل الوصلة متزامن قبل أي DB await، كي لا تبدأ pump جديدة على مقبس ميت.
        // removeLink يحذف بالهوية فقط، فلا يمس وصلة أحدث لنفس الجهاز.
        removeLink(closingLink);
        await requeueInflight(closingLink);
      }
    },
  };
}
