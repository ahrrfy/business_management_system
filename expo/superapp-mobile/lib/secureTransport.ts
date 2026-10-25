import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";
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
} from "./secureTransportPayload";

export type {
  MobileAttendanceHistory,
  MobileCommandCenter,
  MobileExpoPushStatus,
  MobileLeaveCommand,
  MobilePayslip,
  MobileTaskCommand,
  MobileToday,
  NativeLoginResult,
} from "./secureTransportPayload";

export type NativeSecureTransport = Readonly<{
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
  getOperationsActor(): Promise<string>;
  listBranches(): Promise<string>;
  listSalesInvoices(limit: number, offset: number): Promise<string>;
  getSalesInvoice(invoiceId: number): Promise<string>;
  listAdminCatalog(branchId: number, limit: number, q: string | null): Promise<string>;
  listCustomers(): Promise<string>;
  getDecisionsInbox(limit: number): Promise<string>;
  getSuperAppApprovalInbox(limit: number, offset: number): Promise<string>;
  getTreasuryDashboard(): Promise<string>;
  getTreasuryRecentMovements(limit: number): Promise<string>;
  listSuppliers(): Promise<string>;
  listPurchases(limit: number): Promise<string>;
  logout(): Promise<Readonly<{ cleared: true }>>;
}>;

export type OperationsActor = Readonly<{
  id: number;
  role: string;
  branchId: number | null;
  isOwner: boolean;
  name?: string;
}>;

export type OperationsBranchSummary = Readonly<{
  id: number;
  name: string;
  code?: string;
  type?: string;
}>;

const transport = requireOptionalNativeModule<NativeSecureTransport>("AlrueyaSecureTransport");

let testTransportOverride: NativeSecureTransport | null | undefined = undefined;

export function __setNativeSecureTransportForTests(
  override: Partial<NativeSecureTransport> | null | undefined,
): void {
  if (override !== undefined && process.env.NODE_ENV !== "test") {
    throw new Error("Test transport override is restricted to test environments.");
  }
  if (override == null) {
    testTransportOverride = override;
    return;
  }
  const unimplemented = async (): Promise<never> => {
    throw new Error("Unmocked NativeSecureTransport procedure called in test.");
  };
  testTransportOverride = {
    login: override.login ?? unimplemented,
    verifyTwoFactor: override.verifyTwoFactor ?? unimplemented,
    getMobileToday: override.getMobileToday ?? unimplemented,
    getMobileAttendanceHistory: override.getMobileAttendanceHistory ?? unimplemented,
    revealMobilePayslip: override.revealMobilePayslip ?? unimplemented,
    createMobileRequestId: override.createMobileRequestId ?? unimplemented,
    requestMobileLeave: override.requestMobileLeave ?? unimplemented,
    withdrawLatestMobileLeave: override.withdrawLatestMobileLeave ?? unimplemented,
    startFocusedMobileTask: override.startFocusedMobileTask ?? unimplemented,
    resolveFocusedMobileTask: override.resolveFocusedMobileTask ?? unimplemented,
    getMobileCommandCenter: override.getMobileCommandCenter ?? unimplemented,
    getMobileExpoPushStatus: override.getMobileExpoPushStatus ?? unimplemented,
    registerMobileExpoPush: override.registerMobileExpoPush ?? unimplemented,
    revokeMobileExpoPush: override.revokeMobileExpoPush ?? unimplemented,
    getOperationsActor: override.getOperationsActor ?? unimplemented,
    listBranches: override.listBranches ?? unimplemented,
    listSalesInvoices: override.listSalesInvoices ?? unimplemented,
    getSalesInvoice: override.getSalesInvoice ?? unimplemented,
    listAdminCatalog: override.listAdminCatalog ?? unimplemented,
    listCustomers: override.listCustomers ?? unimplemented,
    getDecisionsInbox: override.getDecisionsInbox ?? unimplemented,
    getSuperAppApprovalInbox: override.getSuperAppApprovalInbox ?? unimplemented,
    getTreasuryDashboard: override.getTreasuryDashboard ?? unimplemented,
    getTreasuryRecentMovements: override.getTreasuryRecentMovements ?? unimplemented,
    listSuppliers: override.listSuppliers ?? unimplemented,
    listPurchases: override.listPurchases ?? unimplemented,
    logout: override.logout ?? (async () => ({ cleared: true as const })),
  };
}

function activeNativeModule(): NativeSecureTransport | null {
  if (testTransportOverride !== undefined) return testTransportOverride;
  return transport ?? null;
}

export function isNativeSecureTransportAvailable(): boolean {
  return activeNativeModule() != null;
}

export function isWebTransportFallbackAllowed(): boolean {
  return (
    Platform.OS === "web" ||
    process.env.NODE_ENV === "test" ||
    process.env.EXPO_PUBLIC_ALLOW_WEB_TRANSPORT_FALLBACK === "1"
  );
}

const getBackendUrl = (): string => {
  if (typeof window !== "undefined" && window.location) {
    if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
      return "http://localhost:3000";
    }
    return window.location.origin;
  }
  return "http://localhost:3000";
};

async function webTrpcQuery(
  procedure: string,
  input?: Record<string, unknown>,
  fallbackError = "تعذر جلب البيانات من الخادم",
): Promise<string> {
  const url = new URL(`${getBackendUrl()}/api/trpc/${procedure}`);
  if (input !== undefined) {
    url.searchParams.set("batch", "1");
    url.searchParams.set("input", JSON.stringify({ "0": { json: input } }));
  }
  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "x-erp-csrf": "1",
    },
    credentials: "include",
  });
  if (!res.ok) {
    const errJson = await res.json().catch(() => ({}));
    const errItem = Array.isArray(errJson) ? errJson[0] : errJson;
    throw new Error(errItem?.error?.json?.message || fallbackError);
  }
  const data = await res.json();
  const item = Array.isArray(data) ? data[0] : data;
  if (item?.error) {
    throw new Error(item.error?.json?.message || fallbackError);
  }
  return JSON.stringify(item?.result?.data?.json ?? null);
}

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
      if (user && typeof user === "object") {
        const { ticket: _ticket, ...safeUser } = user as Record<string, unknown>;
        window.sessionStorage?.setItem("alrueya_superapp_web_user", JSON.stringify(safeUser));
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

  async verifyTwoFactor(ticket: string, code: string | null, recoveryCode: StringOrNull): Promise<string> {
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
    return webTrpcQuery("superApp.mobileToday", undefined, "تعذر جلب بيانات اليوم");
  },

  async getMobileAttendanceHistory(): Promise<string> {
    return webTrpcQuery("superApp.mobileAttendanceHistory", undefined, "تعذر جلب سجل الحضور");
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
    if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      bytes[6] = (bytes[6]! & 0x0f) | 0x40;
      bytes[8] = (bytes[8]! & 0x3f) | 0x80;
      const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
    }
    throw new SecureTransportUnavailableError();
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
    return webTrpcQuery("superApp.mobileCommandCenter", undefined, "تعذر جلب بيانات غرفة القيادة");
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

  async getOperationsActor(): Promise<string> {
    return webTrpcQuery("auth.me", undefined, "تعذر التحقق من هوية الجلسة");
  },

  async listBranches(): Promise<string> {
    return webTrpcQuery("branches.list", undefined, "تعذر جلب قائمة الفروع");
  },

  async listSalesInvoices(limit: number, offset: number): Promise<string> {
    return webTrpcQuery("sales.list", { limit, offset }, "تعذر جلب فواتير المبيعات");
  },

  async getSalesInvoice(invoiceId: number): Promise<string> {
    return webTrpcQuery("sales.get", { invoiceId }, "تعذر جلب تفاصيل الفاتورة");
  },

  async listAdminCatalog(branchId: number, limit: number, q: string | null): Promise<string> {
    const input: Record<string, unknown> = { branchId, limit };
    const cleanQ = q?.trim();
    if (cleanQ) input.q = cleanQ;
    return webTrpcQuery("catalog.adminList", input, "تعذر جلب بيانات المخزون");
  },

  async listCustomers(): Promise<string> {
    return webTrpcQuery("customers.list", undefined, "تعذر جلب قائمة العملاء");
  },

  async getDecisionsInbox(limit: number): Promise<string> {
    return webTrpcQuery("decisions.inbox", { limit }, "تعذر جلب صندوق القرارات");
  },

  async getSuperAppApprovalInbox(limit: number, offset: number): Promise<string> {
    return webTrpcQuery("superApp.approvalInbox", { limit, offset }, "تعذر جلب صندوق الاعتمادات");
  },

  async getTreasuryDashboard(): Promise<string> {
    return webTrpcQuery("treasury.getDashboard", undefined, "تعذر جلب بيانات الخزينة");
  },

  async getTreasuryRecentMovements(limit: number): Promise<string> {
    return webTrpcQuery("treasury.getRecentMovements", { limit }, "تعذر جلب حركات الخزينة");
  },

  async listSuppliers(): Promise<string> {
    return webTrpcQuery("suppliers.list", undefined, "تعذر جلب قائمة الموردين");
  },

  async listPurchases(limit: number): Promise<string> {
    return webTrpcQuery("purchases.list", { limit }, "تعذر جلب أوامر الشراء");
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

type StringOrNull = string | null;

export class SecureTransportUnavailableError extends Error {
  constructor() {
    super("يتطلب هذا الإجراء Development Build موثقاً على هاتف، ولا يعمل في المتصفح أو Expo Go.");
    this.name = "SecureTransportUnavailableError";
  }
}

export class DecisionStepUpRequiredError extends Error {
  constructor() {
    super(
      "يتطلب اعتماد أو رفض القرارات المالية والتشغيلية تذكرة تحقق إضافية مستقلة (Step-Up) عبر لوحة الحوكمة المعتمدة على الويب وفق سياسة أمان التطبيق.",
    );
    this.name = "DecisionStepUpRequiredError";
  }
}

function nativeTransport(): NativeSecureTransport {
  const active = activeNativeModule();
  if (active) return active;
  if (isWebTransportFallbackAllowed()) return webTransport;
  throw new SecureTransportUnavailableError();
}

function assertBoundedInteger(value: number, min: number, max: number, label: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`قيمة غير صالحة لمعامل ${label}`);
  }
  return value;
}

function parseJsonPayload<T>(raw: string, fallback: T): T {
  try {
    const parsed = JSON.parse(raw) as T;
    return parsed ?? fallback;
  } catch {
    throw new Error("استجابة الخادم غير صالحة.");
  }
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

export async function getNativeOperationsActor(): Promise<OperationsActor | null> {
  const raw = parseJsonPayload<Record<string, unknown> | null>(
    await nativeTransport().getOperationsActor(),
    null,
  );
  if (!raw || typeof raw !== "object" || typeof raw.id !== "number" || typeof raw.role !== "string") {
    return null;
  }
  return {
    id: raw.id,
    role: raw.role,
    branchId: typeof raw.branchId === "number" ? raw.branchId : null,
    isOwner: Boolean(raw.isOwner),
    name: typeof raw.name === "string" ? raw.name : undefined,
  };
}

export async function listNativeBranches(): Promise<OperationsBranchSummary[]> {
  const raw = parseJsonPayload<unknown[]>(await nativeTransport().listBranches(), []);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"))
    .filter((entry) => typeof entry.id === "number" && typeof entry.name === "string")
    .map((entry) => ({
      id: entry.id as number,
      name: entry.name as string,
      code: typeof entry.code === "string" ? entry.code : undefined,
      type: typeof entry.type === "string" ? entry.type : undefined,
    }));
}

export async function listNativeSalesInvoices(input?: {
  limit?: number;
  offset?: number;
}): Promise<Record<string, unknown>[]> {
  const limit = assertBoundedInteger(input?.limit ?? 50, 1, 500, "limit");
  const offset = assertBoundedInteger(input?.offset ?? 0, 0, 1_000_000, "offset");
  const raw = parseJsonPayload<unknown[]>(await nativeTransport().listSalesInvoices(limit, offset), []);
  return Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
}

export async function getNativeSalesInvoice(invoiceId: number): Promise<Record<string, unknown> | null> {
  const validId = assertBoundedInteger(invoiceId, 1, 2_147_483_647, "invoiceId");
  const raw = parseJsonPayload<Record<string, unknown> | null>(
    await nativeTransport().getSalesInvoice(validId),
    null,
  );
  return raw && typeof raw === "object" ? raw : null;
}

export async function listNativeAdminCatalog(input: {
  branchId: number;
  limit?: number;
  q?: string;
}): Promise<{ rows: Record<string, unknown>[] }> {
  const branchId = assertBoundedInteger(input.branchId, 1, 2_147_483_647, "branchId");
  const limit = assertBoundedInteger(input.limit ?? 60, 1, 500, "limit");
  const cleanQ = input.q?.trim() || null;
  if (cleanQ && (cleanQ.length > 200 || /[\r\n]/.test(cleanQ))) {
    throw new Error("نص البحث غير صالح.");
  }
  const raw = parseJsonPayload<{ rows?: unknown[] } | null>(
    await nativeTransport().listAdminCatalog(branchId, limit, cleanQ),
    null,
  );
  return {
    rows: Array.isArray(raw?.rows) ? (raw.rows as Record<string, unknown>[]) : [],
  };
}

export async function listNativeCustomers(): Promise<Record<string, unknown>[]> {
  const raw = parseJsonPayload<unknown[]>(await nativeTransport().listCustomers(), []);
  return Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
}

export async function getNativeDecisionsInbox(limit = 40): Promise<{ rows: Record<string, unknown>[] }> {
  const validLimit = assertBoundedInteger(limit, 1, 500, "limit");
  const raw = parseJsonPayload<{ rows?: unknown[] } | null>(
    await nativeTransport().getDecisionsInbox(validLimit),
    null,
  );
  return {
    rows: Array.isArray(raw?.rows) ? (raw.rows as Record<string, unknown>[]) : [],
  };
}

export async function getNativeSuperAppApprovalInbox(input?: {
  limit?: number;
  offset?: number;
}): Promise<Record<string, unknown>[]> {
  const limit = assertBoundedInteger(input?.limit ?? 40, 1, 50, "limit");
  const offset = assertBoundedInteger(input?.offset ?? 0, 0, 450, "offset");
  const raw = parseJsonPayload<unknown[]>(
    await nativeTransport().getSuperAppApprovalInbox(limit, offset),
    [],
  );
  return Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
}

export async function getNativeTreasuryDashboard(): Promise<Record<string, unknown>> {
  const raw = parseJsonPayload<Record<string, unknown> | null>(
    await nativeTransport().getTreasuryDashboard(),
    null,
  );
  return raw && typeof raw === "object" ? raw : {};
}

export async function getNativeTreasuryRecentMovements(limit = 10): Promise<Record<string, unknown>[]> {
  const validLimit = assertBoundedInteger(limit, 1, 100, "limit");
  const raw = parseJsonPayload<unknown>(
    await nativeTransport().getTreasuryRecentMovements(validLimit),
    null,
  );
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  if (raw && typeof raw === "object" && Array.isArray((raw as { rows?: unknown[] }).rows)) {
    return (raw as { rows: Record<string, unknown>[] }).rows;
  }
  return [];
}

export async function listNativeSuppliers(): Promise<Record<string, unknown>[]> {
  const raw = parseJsonPayload<unknown[]>(await nativeTransport().listSuppliers(), []);
  return Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
}

export async function listNativePurchases(limit = 40): Promise<Record<string, unknown>[]> {
  const validLimit = assertBoundedInteger(limit, 1, 500, "limit");
  const raw = parseJsonPayload<unknown>(await nativeTransport().listPurchases(validLimit), null);
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  if (raw && typeof raw === "object" && Array.isArray((raw as { rows?: unknown[] }).rows)) {
    return (raw as { rows: Record<string, unknown>[] }).rows;
  }
  return [];
}

/**
 * SECURITY.md Rule #3: Financial/operational approvals require an independent,
 * short-lived step-up ticket. Native builds deliberately refuse un-stepped-up
 * decision execution; web preview uses CSPRNG request IDs only when allowed.
 */
export async function submitWebPreviewDecisionOnly(input: {
  kind: string;
  id: number;
  action: "APPROVE" | "REJECT";
  reason?: string;
  expectedVersion?: number | null;
}): Promise<{ outcome: string }> {
  if (activeNativeModule() != null || !isWebTransportFallbackAllowed()) {
    throw new DecisionStepUpRequiredError();
  }
  const cleanKind = input.kind.trim();
  if (!cleanKind || cleanKind.length > 80) {
    throw new Error("نوع القرار غير صالح.");
  }
  const validId = assertBoundedInteger(input.id, 1, 2_147_483_647, "id");
  if (input.action !== "APPROVE" && input.action !== "REJECT") {
    throw new Error("إجراء القرار غير صالح.");
  }
  const cleanReason = input.reason?.trim();
  if (cleanReason && cleanReason.length > 1000) {
    throw new Error("ملاحظة القرار تتجاوز الحد المسموح.");
  }
  const clientRequestId = await createNativeMobileRequestId();
  const res = await fetch(`${getBackendUrl()}/api/trpc/decisions.decide?batch=1`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-erp-csrf": "1",
    },
    credentials: "include",
    body: JSON.stringify({
      "0": {
        json: {
          kind: cleanKind,
          id: validId,
          action: input.action,
          clientRequestId,
          reason: cleanReason || undefined,
          expectedVersion: input.expectedVersion ?? null,
        },
      },
    }),
  });
  if (!res.ok) {
    const errJson = await res.json().catch(() => ({}));
    const errItem = Array.isArray(errJson) ? errJson[0] : errJson;
    throw new Error(errItem?.error?.json?.message || `خطأ في الاتصال بالخادم (${res.status})`);
  }
  const data = await res.json();
  const item = Array.isArray(data) ? data[0] : data;
  if (item?.error) {
    throw new Error(item.error?.json?.message || "خطأ في معالجة القرار");
  }
  return (item?.result?.data?.json as { outcome: string }) ?? { outcome: "OK" };
}

export async function signOutFromNativeTransport(): Promise<void> {
  await nativeTransport().logout();
}
