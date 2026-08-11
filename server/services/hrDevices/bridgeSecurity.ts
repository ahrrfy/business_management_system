import { createHash, timingSafeEqual } from "node:crypto";
import { BlockList, isIP } from "node:net";
import type { IncomingMessage } from "node:http";

export interface BridgeSecurityConfig {
  host: string;
  allowlist: string[];
  sharedSecret: string;
  deviceIdentityBindings: Record<string, DeviceIdentityBinding>;
  deviceIdentityBindingsValid: boolean;
  legacyIdentityMigration: boolean;
  legacyIdentityMigrationValid: boolean;
  maxPayloadBytes: number;
  requestTimeoutMs: number;
  idleTimeoutMs: number;
  maxRequestsPerMinute: number;
  maxWsConnectionsPerIp: number;
}

export interface DeviceIdentityBinding {
  allowlist: string[];
  sharedSecret: string;
}

export interface DeviceIdentityRecord {
  id?: number;
  serialNumber: string | null;
  ip: string | null;
}

export interface DeviceIdentityContext {
  remoteAddress: string | undefined;
  credential: string;
}

export type DeviceIdentityDecision =
  | "BOUND"
  | "LEGACY_MIGRATION"
  | "SERIAL_MISMATCH"
  | "UNBOUND"
  | "BINDING_INVALID"
  | "IP_MISMATCH"
  | "CREDENTIAL_MISMATCH";

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

const SERIAL_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

function parseDeviceIdentityBindings(raw: string | undefined): {
  bindings: Record<string, DeviceIdentityBinding>;
  valid: boolean;
} {
  const text = raw?.trim();
  if (!text) return { bindings: {}, valid: true };
  if (Buffer.byteLength(text, "utf8") > 64 * 1024) return { bindings: {}, valid: false };
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { bindings: {}, valid: false };
    }
    const bindings: Record<string, DeviceIdentityBinding> = {};
    for (const [serialNumber, rawBinding] of Object.entries(parsed)) {
      if (!SERIAL_PATTERN.test(serialNumber) || !rawBinding || typeof rawBinding !== "object" || Array.isArray(rawBinding)) {
        return { bindings: {}, valid: false };
      }
      const candidate = rawBinding as Record<string, unknown>;
      const rawAllowlist = candidate.allowlist ?? candidate.ips ?? [];
      const allowlist = Array.isArray(rawAllowlist)
        ? rawAllowlist.map((item) => (typeof item === "string" ? item.trim() : ""))
        : [];
      if (
        !Array.isArray(rawAllowlist) ||
        allowlist.length > 16 ||
        allowlist.some((entry) => !entry || entry.length > 80)
      ) {
        return { bindings: {}, valid: false };
      }
      const sharedSecret = typeof candidate.sharedSecret === "string"
        ? candidate.sharedSecret.trim()
        : typeof candidate.secret === "string"
          ? candidate.secret.trim()
          : "";
      if (sharedSecret.length > 512 || (allowlist.length === 0 && !sharedSecret)) {
        return { bindings: {}, valid: false };
      }
      bindings[serialNumber] = { allowlist, sharedSecret };
    }
    return { bindings, valid: true };
  } catch {
    return { bindings: {}, valid: false };
  }
}

/**
 * أسرار الجسر مفاتيح آلة طويلة عشوائية، لا كلمات مرور بشرية. نرفض الأنماط الدورية
 * (`x…x` أو `abcdabcd…`) والعبارات التجريبية حتى لا يمرّ الحارس بمجرد بلوغ الطول.
 */
export function isStrongBridgeSecret(secret: string): boolean {
  if (Buffer.byteLength(secret, "utf8") < 32 || Buffer.byteLength(secret, "utf8") > 512) return false;
  if (/(?:change[ _-]?me|password|example|placeholder|test[ _-]?secret)/i.test(secret)) return false;
  if (new Set(Array.from(secret)).size < 10) return false;
  for (let period = 1; period <= Math.min(16, Math.floor(secret.length / 2)); period += 1) {
    if (secret.length % period !== 0) continue;
    const unit = secret.slice(0, period);
    if (unit.repeat(secret.length / period) === secret) return false;
  }
  return true;
}

function networkEntryValid(entry: string): boolean {
  const [network, prefixText, extra] = entry.split("/");
  if (extra !== undefined) return false;
  const family = isIP(network);
  if (family === 0) return false;
  if (prefixText === undefined) return true;
  const prefix = Number(prefixText);
  return Number.isInteger(prefix) && prefix >= 0 && prefix <= (family === 4 ? 32 : 128);
}

export function isDangerouslyBroadNetwork(entry: string): boolean {
  const [network, prefixText] = entry.split("/");
  return isIP(network) !== 0 && Number(prefixText) === 0;
}

export function bridgeNetworkPolicyFailure(allowlist: string[]): string | null {
  if (allowlist.some((entry) => !networkEntryValid(entry))) return "قائمة عناوين جسر الحضور تحتوي عنوان IP/CIDR غير صالح";
  if (allowlist.some(isDangerouslyBroadNetwork)) {
    return "قائمة عناوين جسر الحضور لا يجوز أن تحتوي 0.0.0.0/0 أو ::/0";
  }
  return null;
}

/** عنوان مضيف واحد فقط؛ الشبكات الأوسع تحتاج مفتاح جهاز خاصاً لأنها لا تميّز جهازاً بعينه. */
export function isExactHostNetwork(entry: string): boolean {
  const [network, prefixText, extra] = entry.split("/");
  if (extra !== undefined) return false;
  const family = isIP(network);
  if (family === 0) return false;
  if (prefixText === undefined) return true;
  return Number(prefixText) === (family === 4 ? 32 : 128);
}

function sameExactHostNetwork(left: string, right: string): boolean {
  if (!isExactHostNetwork(left) || !isExactHostNetwork(right)) return false;
  const leftAddress = left.split("/")[0];
  const rightAddress = right.split("/")[0];
  const family = isIP(leftAddress);
  if (family === 0 || isIP(rightAddress) !== family) return false;
  try {
    const block = new BlockList();
    const type = family === 4 ? "ipv4" : "ipv6";
    block.addAddress(leftAddress, type);
    return block.check(rightAddress, type);
  } catch {
    return false;
  }
}

function secretFingerprint(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function resolveBridgeSecurityConfig(env: NodeJS.ProcessEnv = process.env): BridgeSecurityConfig {
  const identity = parseDeviceIdentityBindings(env.HR_DEVICE_IDENTITY_BINDINGS);
  const rawLegacyMigration = env.HR_DEVICE_LEGACY_IDENTITY_MIGRATION?.trim() ?? "";
  return {
    // نبقي 0.0.0.0 افتراضياً للتوافق مع الأجهزة المنشورة؛ في الإنتاج يوصى بعنوان LAN محدد.
    host: env.HR_DEVICE_HOST?.trim() || "0.0.0.0",
    allowlist: (env.HR_DEVICE_IP_ALLOWLIST ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    sharedSecret: env.HR_DEVICE_SHARED_SECRET?.trim() || "",
    deviceIdentityBindings: identity.bindings,
    deviceIdentityBindingsValid: identity.valid,
    legacyIdentityMigration: rawLegacyMigration === "1",
    legacyIdentityMigrationValid: rawLegacyMigration === "" || rawLegacyMigration === "0" || rawLegacyMigration === "1",
    maxPayloadBytes: boundedInteger(env.HR_DEVICE_MAX_PAYLOAD_BYTES, 8 * 1024 * 1024, 64 * 1024, 16 * 1024 * 1024),
    requestTimeoutMs: boundedInteger(env.HR_DEVICE_REQUEST_TIMEOUT_MS, 30_000, 5_000, 120_000),
    idleTimeoutMs: boundedInteger(env.HR_DEVICE_IDLE_TIMEOUT_MS, 180_000, 30_000, 30 * 60_000),
    maxRequestsPerMinute: boundedInteger(env.HR_DEVICE_RATE_LIMIT_PER_MINUTE, 240, 10, 10_000),
    maxWsConnectionsPerIp: boundedInteger(env.HR_DEVICE_MAX_WS_PER_IP, 4, 1, 100),
  };
}

/** في الإنتاج الجسر fail-closed: شبكة محددة أو سر بوابة قوي، وإلا لا يُفتح المنفذ. */
export function productionSecurityFailure(
  config: BridgeSecurityConfig,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (env.NODE_ENV !== "production") return null;
  const globalNetworkFailure = bridgeNetworkPolicyFailure(config.allowlist);
  if (globalNetworkFailure) return globalNetworkFailure;
  if (config.sharedSecret && !isStrongBridgeSecret(config.sharedSecret)) {
    return "HR_DEVICE_SHARED_SECRET يجب أن يكون عشوائياً وغير دوري بطول 32 بايت على الأقل";
  }
  if (config.allowlist.length === 0 && !isStrongBridgeSecret(config.sharedSecret)) {
    return (
      "رفض تشغيل جسر الحضور في الإنتاج دون حماية: اضبط HR_DEVICE_IP_ALLOWLIST " +
      "على IP/CIDR الحقيقي لأجهزة الشركة، أو HR_DEVICE_SHARED_SECRET عشوائياً بطول 32 بايت على الأقل"
    );
  }
  if (!config.deviceIdentityBindingsValid || !config.legacyIdentityMigrationValid) {
    return "إعداد ربط هوية أجهزة الحضور غير صالح";
  }
  if (config.legacyIdentityMigration) {
    return "HR_DEVICE_LEGACY_IDENTITY_MIGRATION يجب أن يساوي 0 في الإنتاج";
  }
  const globalSecretFingerprint = config.sharedSecret ? secretFingerprint(config.sharedSecret) : "";
  const deviceSecretFingerprints = new Set<string>();
  const uncredentialedAddresses: string[] = [];
  for (const binding of Object.values(config.deviceIdentityBindings)) {
    const networkFailure = bridgeNetworkPolicyFailure(binding.allowlist);
    if (networkFailure) return networkFailure;
    if (binding.sharedSecret && !isStrongBridgeSecret(binding.sharedSecret)) {
      return "أحد أسرار ربط أجهزة الحضور ضعيف أو دوري";
    }
    if (!binding.sharedSecret && binding.allowlist.some((entry) => !isExactHostNetwork(entry))) {
      return "ربط شبكة جهاز أوسع من عنوان مضيف واحد يتطلب مفتاح جهاز خاصاً";
    }
    if (binding.sharedSecret) {
      const fingerprint = secretFingerprint(binding.sharedSecret);
      if (fingerprint === globalSecretFingerprint || deviceSecretFingerprints.has(fingerprint)) {
        return "يجب أن يكون مفتاح كل جهاز فريداً ومختلفاً عن سر بوابة الجسر";
      }
      deviceSecretFingerprints.add(fingerprint);
    } else {
      for (const entry of binding.allowlist) {
        if (uncredentialedAddresses.some((existing) => sameExactHostNetwork(existing, entry))) {
          return "لا يجوز ربط جهازين بالعنوان نفسه دون مفتاح خاص فريد";
        }
        uncredentialedAddresses.push(entry);
      }
    }
  }
  return null;
}

export function normalizeRemoteAddress(address: string | undefined): string {
  if (!address) return "";
  const withoutZone = address.split("%")[0];
  return withoutZone.startsWith("::ffff:") ? withoutZone.slice(7) : withoutZone;
}

function matchesEntry(ip: string, entry: string): boolean {
  const [network, prefixText] = entry.split("/");
  if (prefixText === undefined) return normalizeRemoteAddress(network) === ip;
  const family = isIP(network);
  if (family === 0 || isIP(ip) !== family) return false;
  const prefix = Number(prefixText);
  const maxPrefix = family === 4 ? 32 : 128;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) return false;
  try {
    const blockList = new BlockList();
    const type = family === 4 ? "ipv4" : "ipv6";
    blockList.addSubnet(network, prefix, type);
    return blockList.check(ip, type);
  } catch {
    return false;
  }
}

/**
 * بوّابة الشبكة. `learnedOrigins` (اختياريّ) = عناوين **مُتعلَّمة من القاعدة**: عناوين الأجهزة
 * المُفعَّلة + عناوين جلسات الموظّفين المُصادَقة الحيّة (راجع `originTrust.ts`). وجودها يحلّ
 * علّة «مزوّد الإنترنت غيّر عنوان المتجر ⇒ انقطاع صامت حتى تعديل ‎.env يدوياً بـSSH».
 *
 * ⚠️ لا تمنح هذه المجموعة ثقةً بذاتها: هي بوّابةُ **وصولٍ شبكيّ** فقط، وتظلّ بوّابة الهويّة
 * (`authorizeDeviceIdentity`) تطالب برقمٍ تسلسليّ مطابقٍ وربطٍ صحيح قبل قبول أيّ بصمة.
 */
export function isRemoteAllowed(
  address: string | undefined,
  allowlist: string[],
  learnedOrigins?: ReadonlySet<string>,
): boolean {
  if (allowlist.length === 0) return true;
  const ip = normalizeRemoteAddress(address);
  if (allowlist.some((entry) => matchesEntry(ip, entry))) return true;
  return Boolean(ip) && Boolean(learnedOrigins?.has(ip));
}

export function constantTimeSecretEquals(actual: string, expected: string): boolean {
  if (!expected) return true;
  const actualDigest = createHash("sha256").update(actual).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

export function requestSecret(req: IncomingMessage): string {
  const authorization = req.headers.authorization;
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7).trim();
  const header = req.headers["x-hr-device-secret"];
  if (typeof header === "string") return header;
  try {
    const url = new URL(req.url ?? "/", "http://device.local");
    return url.searchParams.get("token") ?? url.searchParams.get("secret") ?? "";
  } catch {
    return "";
  }
}

/** مفتاح الجهاز منفصل عن سر بوابة الجسر العام حتى لا يصبح الاعتماد العام هو هوية كل SN. */
export function requestDeviceCredential(req: IncomingMessage): string {
  const header = req.headers["x-hr-device-key"];
  if (typeof header === "string") return header.trim();
  try {
    const url = new URL(req.url ?? "/", "http://device.local");
    return url.searchParams.get("deviceKey")?.trim() ?? "";
  } catch {
    return "";
  }
}

export function isRequestAuthorized(
  req: IncomingMessage,
  config: BridgeSecurityConfig,
  learnedOrigins?: ReadonlySet<string>,
): boolean {
  return (
    isRemoteAllowed(req.socket.remoteAddress, config.allowlist, learnedOrigins) &&
    constantTimeSecretEquals(requestSecret(req), config.sharedSecret)
  );
}

/**
 * ربط ثقة ثانٍ بعد بوابة الشبكة العامة: SN لا يكفي. الجهاز المفعّل يجب أن يطابق
 * عنوانه المخزّن/المربوط، ومفتاحه الخاص إن ضُبط. الأجهزة القديمة غير المربوطة تُرفض
 * افتراضياً ولا تمرّ إلا بعلم هجرة صريح ومؤقت.
 */
export function authorizeDeviceIdentity(
  device: DeviceIdentityRecord,
  claimedSerialNumber: string,
  context: DeviceIdentityContext,
  config: BridgeSecurityConfig,
): { authorized: boolean; decision: DeviceIdentityDecision } {
  const serialNumber = claimedSerialNumber.trim();
  if (!SERIAL_PATTERN.test(serialNumber) || device.serialNumber !== serialNumber) {
    return { authorized: false, decision: "SERIAL_MISMATCH" };
  }
  const binding = config.deviceIdentityBindings[serialNumber];
  // الربط الصريح هو مصدر الحقيقة إن وُجد؛ لا نوسّعه بـIP قديم في قاعدة البيانات بمنطق OR.
  const networkBindings = binding
    ? binding.allowlist
    : [device.ip?.trim() ?? ""].filter(Boolean);
  const expectedCredential = binding?.sharedSecret ?? "";
  if (networkBindings.length === 0 && !expectedCredential) {
    return config.legacyIdentityMigration
      ? { authorized: true, decision: "LEGACY_MIGRATION" }
      : { authorized: false, decision: "UNBOUND" };
  }
  if (networkBindings.length > 0 && bridgeNetworkPolicyFailure(networkBindings)) {
    return { authorized: false, decision: "BINDING_INVALID" };
  }
  if (!expectedCredential && networkBindings.some((entry) => !isExactHostNetwork(entry))) {
    return { authorized: false, decision: "BINDING_INVALID" };
  }
  if (networkBindings.length > 0 && !isRemoteAllowed(context.remoteAddress, networkBindings)) {
    return { authorized: false, decision: "IP_MISMATCH" };
  }
  if (expectedCredential && !constantTimeSecretEquals(context.credential, expectedCredential)) {
    return { authorized: false, decision: "CREDENTIAL_MISMATCH" };
  }
  return { authorized: true, decision: "BOUND" };
}

/**
 * تدقيق خالص لصفوف الأجهزة المفعّلة قبل فتح المنفذ. يمنع أن تعلن العملية online
 * فيما جهاز مفعّل بلا ربط، أو أن يشترك جهازان في IP واحد بلا مفتاح خاص يميزهما.
 */
export function enabledDeviceIdentityFailure(
  devices: DeviceIdentityRecord[],
  config: BridgeSecurityConfig,
): string | null {
  const uncredentialedAddresses: Array<{ entry: string; serialNumber: string }> = [];
  for (const device of devices) {
    const serialNumber = device.serialNumber?.trim() ?? "";
    if (!SERIAL_PATTERN.test(serialNumber)) return "جهاز مفعّل بلا رقم تسلسلي صالح";
    const binding = config.deviceIdentityBindings[serialNumber];
    const networks = binding ? binding.allowlist : [device.ip?.trim() ?? ""].filter(Boolean);
    const credential = binding?.sharedSecret ?? "";
    if (networks.length === 0 && !credential) {
      if (config.legacyIdentityMigration) continue;
      return `الجهاز ${serialNumber} مفعّل بلا ربط هوية`;
    }
    const networkFailure = bridgeNetworkPolicyFailure(networks);
    if (networkFailure) return `الجهاز ${serialNumber}: ${networkFailure}`;
    if (!credential) {
      if (networks.some((entry) => !isExactHostNetwork(entry))) {
        return `الجهاز ${serialNumber}: الشبكة المشتركة تحتاج مفتاح جهاز خاصاً`;
      }
      for (const entry of networks) {
        const previous = uncredentialedAddresses.find((item) => sameExactHostNetwork(item.entry, entry));
        if (previous && previous.serialNumber !== serialNumber) {
          return `الجهازان ${previous.serialNumber} و${serialNumber} يشتركان في IP بلا مفتاحين فريدين`;
        }
        uncredentialedAddresses.push({ entry, serialNumber });
      }
    }
  }
  return null;
}

/** عدّاد نافذة ثابتة محلي للعملية؛ جسر الحضور عملية واحدة، لذلك لا يوجد تباعد بين العمّال. */
export class PerIpRateLimiter {
  private readonly entries = new Map<string, { windowStartedAt: number; count: number }>();

  constructor(private readonly limit: number, private readonly windowMs = 60_000) {}

  allow(address: string | undefined, now = Date.now()): boolean {
    const ip = normalizeRemoteAddress(address) || "unknown";
    if (this.entries.size > 10_000) {
      for (const [key, entry] of Array.from(this.entries)) {
        if (now - entry.windowStartedAt >= this.windowMs) this.entries.delete(key);
      }
    }
    const current = this.entries.get(ip);
    if (!current || now - current.windowStartedAt >= this.windowMs) {
      this.entries.set(ip, { windowStartedAt: now, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= this.limit;
  }
}
