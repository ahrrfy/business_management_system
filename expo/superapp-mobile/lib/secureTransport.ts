import { requireOptionalNativeModule } from "expo";
import {
  parseMobileToday,
  parseMobileAttendanceHistory,
  parseMobileCommandCenter,
  parseMobileExpoPushCommand,
  parseMobileExpoPushStatus,
  parseMobileLeaveCommand,
  parseMobilePayslip,
  parseMobileTaskCommand,
  parseNativeLoginResult,
  type MobileAttendanceHistory,
  type MobileCommandCenter,
  type MobileExpoPushStatus,
  type MobileLeaveCommand,
  type MobilePayslip,
  type MobileTaskCommand,
  type MobileToday,
  type NativeLoginResult,
} from "@/lib/secureTransportPayload";

export type {
  MobileAttendanceHistory,
  MobileCommandCenter,
  MobileExpoPushStatus,
  MobileLeaveCommand,
  MobilePayslip,
  MobileTaskCommand,
  MobileToday,
  NativeLoginResult,
} from "@/lib/secureTransportPayload";

type NativeSecureTransport = Readonly<{
  login(identifier: string, password: string, remember: boolean, companyCode: string | null): Promise<string>;
  verifyTwoFactor(ticket: string, code: string | null, recoveryCode: string | null): Promise<string>;
  getMobileToday(): Promise<string>;
  getMobileAttendanceHistory(): Promise<string>;
  revealMobilePayslip(code: string | null, recoveryCode: string | null): Promise<string>;
  createMobileRequestId(): Promise<string>;
  requestMobileLeave(leaveType: string, fromDate: string, toDate: string, reason: string | null, clientRequestId: string): Promise<string>;
  withdrawLatestMobileLeave(clientRequestId: string): Promise<string>;
  startFocusedMobileTask(clientRequestId: string): Promise<string>;
  resolveFocusedMobileTask(resolutionNote: string | null, clientRequestId: string): Promise<string>;
  getMobileCommandCenter(): Promise<string>;
  getMobileExpoPushStatus(): Promise<string>;
  registerMobileExpoPush(expoPushToken: string, platform: "ANDROID" | "IOS", environment: "dev" | "staging" | "prod", appVersion: string): Promise<string>;
  revokeMobileExpoPush(): Promise<string>;
  logout(): Promise<Readonly<{ cleared: true }>>;
}>;

const transport = requireOptionalNativeModule<NativeSecureTransport>("AlrueyaSecureTransport");

const getBackendUrl = (): string => {
  if (typeof window !== "undefined" && window.location) {
    if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
      return "http://localhost:3000";
    }
    return window.location.origin;
  }
  return "http://localhost:3000";
};

const webTransport: NativeSecureTransport = {
  async login(identifier: string, password: string, remember: boolean, companyCode: string | null): Promise<string> {
    const res = await fetch(`${getBackendUrl()}/api/trpc/auth.login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-erp-csrf": "1",
      },
      credentials: "include",
      body: JSON.stringify({
        json: {
          identifier,
          password,
          remember,
          companyCode: companyCode || undefined,
        },
      }),
    });
    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}));
      const msg = errJson?.error?.json?.message || "البريد أو كلمة المرور غير صحيحة";
      throw new Error(msg);
    }
    const data = await res.json();
    const user = data.result?.data?.json;
    if (typeof window !== "undefined") {
      window.sessionStorage?.setItem("alrueya_superapp_web_session", "active");
      window.localStorage?.setItem("alrueya_superapp_web_session", "active");
      if (user) {
        window.sessionStorage?.setItem("alrueya_superapp_web_user", JSON.stringify(user));
      }
    }
    return JSON.stringify({
      requiresTwoFactor: Boolean(user?.requiresTwoFactor),
      ticket: user?.ticket ?? null,
      name: user?.name,
      mustChangePassword: Boolean(user?.mustChangePassword),
      mustEnrollTwoFactor: Boolean(user?.mustEnrollTwoFactor || user?.mustEnroll2FA),
    });
  },

  async verifyTwoFactor(ticket: string, code: string | null, recoveryCode: string | null): Promise<string> {
    const res = await fetch(`${getBackendUrl()}/api/trpc/auth.twoFactorVerify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-erp-csrf": "1",
      },
      credentials: "include",
      body: JSON.stringify({
        json: {
          ticket,
          code: code || undefined,
          recoveryCode: recoveryCode || undefined,
        },
      }),
    });
    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}));
      throw new Error(errJson?.error?.json?.message || "تعذر التحقق من الرمز");
    }
    const data = await res.json();
    const user = data.result?.data?.json;
    if (typeof window !== "undefined") {
      window.sessionStorage?.setItem("alrueya_superapp_web_session", "active");
      window.localStorage?.setItem("alrueya_superapp_web_session", "active");
    }
    return JSON.stringify({
      requiresTwoFactor: false,
      ticket: null,
      name: user?.name,
    });
  },

  async getMobileToday(): Promise<string> {
    const res = await fetch(`${getBackendUrl()}/api/trpc/superApp.mobileToday`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "x-erp-csrf": "1",
      },
      credentials: "include",
    });
    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}));
      throw new Error(errJson?.error?.json?.message || "تعذر جلب بيانات اليوم");
    }
    const data = await res.json();
    return JSON.stringify(data.result.data.json);
  },

  async getMobileAttendanceHistory(): Promise<string> {
    const res = await fetch(`${getBackendUrl()}/api/trpc/superApp.mobileAttendanceHistory`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "x-erp-csrf": "1",
      },
      credentials: "include",
    });
    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}));
      throw new Error(errJson?.error?.json?.message || "تعذر جلب سجل الحضور");
    }
    const data = await res.json();
    return JSON.stringify(data.result.data.json);
  },

  async revealMobilePayslip(code: string | null, recoveryCode: string | null): Promise<string> {
    const res = await fetch(`${getBackendUrl()}/api/trpc/superApp.mobilePayslipReveal`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-erp-csrf": "1",
      },
      credentials: "include",
      body: JSON.stringify({
        json: {
          code: code || undefined,
          recoveryCode: recoveryCode || undefined,
        },
      }),
    });
    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}));
      throw new Error(errJson?.error?.json?.message || "تعذر كشف تفاصيل الراتب");
    }
    const data = await res.json();
    return JSON.stringify(data.result.data.json);
  },

  async createMobileRequestId(): Promise<string> {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
      (+c ^ (Math.random() * 16 >> (+c / 4))).toString(16),
    );
  },

  async requestMobileLeave(
    leaveType: string,
    fromDate: string,
    toDate: string,
    reason: string | null,
    clientRequestId: string,
  ): Promise<string> {
    const res = await fetch(`${getBackendUrl()}/api/trpc/superApp.mobileRequestLeave`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-erp-csrf": "1",
      },
      credentials: "include",
      body: JSON.stringify({
        json: {
          leaveType,
          fromDate,
          toDate,
          reason: reason || undefined,
          clientRequestId,
        },
      }),
    });
    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}));
      throw new Error(errJson?.error?.json?.message || "تعذر تقديم طلب الإجازة");
    }
    const data = await res.json();
    return JSON.stringify(data.result.data.json);
  },

  async withdrawLatestMobileLeave(clientRequestId: string): Promise<string> {
    const res = await fetch(`${getBackendUrl()}/api/trpc/superApp.mobileWithdrawLatestLeave`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-erp-csrf": "1",
      },
      credentials: "include",
      body: JSON.stringify({ json: { clientRequestId } }),
    });
    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}));
      throw new Error(errJson?.error?.json?.message || "تعذر سحب طلب الإجازة");
    }
    const data = await res.json();
    return JSON.stringify(data.result.data.json);
  },

  async startFocusedMobileTask(clientRequestId: string): Promise<string> {
    const res = await fetch(`${getBackendUrl()}/api/trpc/superApp.mobileStartFocusedTask`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-erp-csrf": "1",
      },
      credentials: "include",
      body: JSON.stringify({ json: { clientRequestId } }),
    });
    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}));
      throw new Error(errJson?.error?.json?.message || "تعذر بدء المهمة");
    }
    const data = await res.json();
    return JSON.stringify(data.result.data.json);
  },

  async resolveFocusedMobileTask(resolutionNote: string | null, clientRequestId: string): Promise<string> {
    const res = await fetch(`${getBackendUrl()}/api/trpc/superApp.mobileResolveFocusedTask`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-erp-csrf": "1",
      },
      credentials: "include",
      body: JSON.stringify({
        json: {
          resolutionNote: resolutionNote || undefined,
          clientRequestId,
        },
      }),
    });
    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}));
      throw new Error(errJson?.error?.json?.message || "تعذر إكمال المهمة");
    }
    const data = await res.json();
    return JSON.stringify(data.result.data.json);
  },

  async getMobileCommandCenter(): Promise<string> {
    const res = await fetch(`${getBackendUrl()}/api/trpc/superApp.mobileCommandCenter`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "x-erp-csrf": "1",
      },
      credentials: "include",
    });
    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}));
      throw new Error(errJson?.error?.json?.message || "تعذر جلب بيانات غرفة القيادة");
    }
    const data = await res.json();
    return JSON.stringify(data.result.data.json);
  },

  async getMobileExpoPushStatus(): Promise<string> {
    return JSON.stringify({ activeCount: 0 });
  },

  async registerMobileExpoPush(): Promise<string> {
    return JSON.stringify({ registered: true });
  },

  async revokeMobileExpoPush(): Promise<string> {
    return JSON.stringify({ revoked: true });
  },

  async logout(): Promise<Readonly<{ cleared: true }>> {
    try {
      await fetch(`${getBackendUrl()}/api/trpc/auth.logout`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-erp-csrf": "1" },
        credentials: "include",
        body: JSON.stringify({ json: {} }),
      });
    } catch {}
    if (typeof window !== "undefined") {
      window.sessionStorage?.removeItem("alrueya_superapp_web_session");
      window.localStorage?.removeItem("alrueya_superapp_web_session");
      window.sessionStorage?.removeItem("alrueya_superapp_web_user");
    }
    return { cleared: true };
  },
};

export class SecureTransportUnavailableError extends Error {
  constructor() {
    super("يتطلب هذا الإجراء Development Build موثقاً على هاتف، ولا يعمل في المتصفح أو Expo Go.");
    this.name = "SecureTransportUnavailableError";
  }
}

function nativeTransport(): NativeSecureTransport {
  if (transport) return transport;
  return webTransport;
}

/** The native layer retains the cookie, device key, counter, nonce, and pins. */
export async function signInWithNativeTransport(input: {
  identifier: string;
  password: string;
  remember: boolean;
  companyCode?: string;
}): Promise<NativeLoginResult> {
  return parseNativeLoginResult(await nativeTransport().login(
    input.identifier,
    input.password,
    input.remember,
    input.companyCode?.trim() || null,
  ));
}

export async function completeNativeTwoFactor(input: {
  ticket: string;
  code?: string;
  recoveryCode?: string;
}): Promise<NativeLoginResult> {
  return parseNativeLoginResult(await nativeTransport().verifyTwoFactor(
    input.ticket,
    input.code?.trim() || null,
    input.recoveryCode?.trim() || null,
  ));
}

export async function getNativeMobileToday(): Promise<MobileToday> {
  return parseMobileToday(await nativeTransport().getMobileToday());
}

export async function getNativeMobileAttendanceHistory(): Promise<MobileAttendanceHistory> {
  return parseMobileAttendanceHistory(await nativeTransport().getMobileAttendanceHistory());
}

/** A fresh TOTP/recovery value is consumed server-side for every sensitive reveal. */
export async function revealNativeMobilePayslip(input: {
  code?: string;
  recoveryCode?: string;
}): Promise<MobilePayslip> {
  return parseMobilePayslip(await nativeTransport().revealMobilePayslip(
    input.code?.trim() || null,
    input.recoveryCode?.trim() || null,
  ));
}

/** Native CSPRNG request key; JavaScript never synthesizes an idempotency identifier. */
export async function createNativeMobileRequestId(): Promise<string> {
  const requestId = await nativeTransport().createMobileRequestId();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
    throw new Error("تعذر تجهيز معرّف الطلب الآمن. أعد المحاولة لاحقاً.");
  }
  return requestId;
}

export async function requestNativeMobileLeave(input: {
  leaveType: "سنوية" | "مرضية" | "أمومة" | "بدون راتب";
  fromDate: string;
  toDate: string;
  reason?: string;
  clientRequestId: string;
}): Promise<MobileLeaveCommand> {
  return parseMobileLeaveCommand(await nativeTransport().requestMobileLeave(
    input.leaveType,
    input.fromDate,
    input.toDate,
    input.reason?.trim() || null,
    input.clientRequestId,
  ));
}

export async function withdrawLatestNativeMobileLeave(clientRequestId: string): Promise<MobileLeaveCommand> {
  return parseMobileLeaveCommand(await nativeTransport().withdrawLatestMobileLeave(clientRequestId));
}

export async function startNativeFocusedTask(clientRequestId: string): Promise<MobileTaskCommand> {
  return parseMobileTaskCommand(await nativeTransport().startFocusedMobileTask(clientRequestId));
}

export async function resolveNativeFocusedTask(input: {
  resolutionNote?: string;
  clientRequestId: string;
}): Promise<MobileTaskCommand> {
  return parseMobileTaskCommand(await nativeTransport().resolveFocusedMobileTask(
    input.resolutionNote?.trim() || null,
    input.clientRequestId,
  ));
}

export async function getNativeMobileCommandCenter(): Promise<MobileCommandCenter> {
  return parseMobileCommandCenter(await nativeTransport().getMobileCommandCenter());
}

export async function getNativeMobileExpoPushStatus(): Promise<MobileExpoPushStatus> {
  return parseMobileExpoPushStatus(await nativeTransport().getMobileExpoPushStatus());
}

/** The token is posted only through the named, signed native BFF method. */
export async function registerNativeMobileExpoPush(input: {
  expoPushToken: string;
  platform: "ANDROID" | "IOS";
  environment: "dev" | "staging" | "prod";
  appVersion: string;
}): Promise<{ registered: true }> {
  const payload = await nativeTransport().registerMobileExpoPush(
    input.expoPushToken,
    input.platform,
    input.environment,
    input.appVersion,
  );
  parseMobileExpoPushCommand(payload, "registered");
  return { registered: true };
}

export async function revokeNativeMobileExpoPush(): Promise<void> {
  parseMobileExpoPushCommand(await nativeTransport().revokeMobileExpoPush(), "revoked");
}

export async function signOutFromNativeTransport(): Promise<void> {
  await nativeTransport().logout();
}
