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

export class SecureTransportUnavailableError extends Error {
  constructor() {
    super("يتطلب هذا الإجراء Development Build موثقاً على هاتف، ولا يعمل في المتصفح أو Expo Go.");
    this.name = "SecureTransportUnavailableError";
  }
}

function nativeTransport(): NativeSecureTransport {
  if (!transport) throw new SecureTransportUnavailableError();
  return transport;
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
