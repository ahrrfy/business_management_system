import crypto from "node:crypto";

/**
 * AES-256-GCM لِتَشفير secrets التَكاملات داخل DB — شَريحة #6.
 *
 * المُفتاح الرَئيسي وَحده في .env (شَيء واحد لا يُمكن تَجَنّبه): `INTEGRATIONS_ENCRYPTION_KEY`.
 * صيغته: 64 hex chars أو base64 لـ32 bytes خام. مَضبوط مَرة واحدة عند الإعداد، لا يَتَغيَّر.
 *
 * الصيغة المُخَزَّنة (base64): `v1:<base64(iv)>:<base64(tag)>:<base64(ciphertext)>`
 *   - v1 = إصدار الـscheme لِتَدوير مُستقبَلي بَلا كَسر السجلّات القَديمة.
 *   - iv = 12 bytes عَشوائية لكل قِيمة ⇒ semantic security.
 *   - tag = 16 bytes auth tag مِن GCM ⇒ يَمنع التَلاعب بـciphertext.
 *
 * السَلامة:
 *   - timing-safe في تَحقّق التَطابق (لا decrypt ⇒ المَكتبة تَفعل ذلك داخلياً).
 *   - throw عند مُفتاح غَير صَحيح أو ciphertext مُتَلاعَب به (`auth tag mismatch`).
 *   - encrypt(null/empty) ⇒ يُعيد null (لا نُخَزّن «»: مُشَفَّر بَلا فائدة).
 */

const KEY_ENV = "INTEGRATIONS_ENCRYPTION_KEY";
const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SCHEME_VERSION = "v1";

let cachedKey: Buffer | null = null;

/** يَجلب المُفتاح مِن .env ويُتحَقّق مِن طوله. مَخفي عبر cache لِتَجَنّب re-decode في كل عَملية. */
function loadKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env[KEY_ENV];
  if (!raw) {
    throw new Error(
      `${KEY_ENV} غَير مَضبوط في .env. ولّد مُفتاحاً 32 bytes: ` +
      `\`openssl rand -hex 32\` ⇒ ضَع النَتيجة في .env. لا تُغَيّره بَعد ضَبطه ` +
      `(يَكسر كل secrets التَكاملات).`,
    );
  }
  // ادعَم hex (64 chars) و base64 (44 chars). الـbase64 أَخصر ولكنه أَيضاً صَالح.
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, "hex");
  } else {
    try {
      key = Buffer.from(raw, "base64");
    } catch {
      throw new Error(`${KEY_ENV} يَجب أن يَكون 64-char hex أو 32-byte base64`);
    }
  }
  if (key.length !== 32) {
    throw new Error(`${KEY_ENV} يَجب أن يَكون 32 bytes (256-bit)؛ المُعطى ${key.length} bytes`);
  }
  cachedKey = key;
  return key;
}

/** يَختبر أن المُفتاح مَضبوط — لِفَحص isReady في الشاشة قَبل عَرض حُقول الإدخال. */
export function isCryptoReady(): boolean {
  try {
    loadKey();
    return true;
  } catch {
    return false;
  }
}

/** يُشَفّر نَصّاً عادياً. null/empty ⇒ null (لا نُخَزّن قِيَماً فارِغة مُشَفَّرة). */
export function encryptSecret(plaintext: string | null | undefined): string | null {
  if (!plaintext) return null;
  const key = loadKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    SCHEME_VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    enc.toString("base64"),
  ].join(":");
}

/** يَفُكّ تَشفير قِيمة مُخَزَّنة. throws لو ciphertext مُتَلاعَب به أو مُفتاح خَطأ. */
export function decryptSecret(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const parts = stored.split(":");
  if (parts.length !== 4) {
    throw new Error(`Encrypted secret malformed (expected 4 parts, got ${parts.length})`);
  }
  const [version, ivB64, tagB64, encB64] = parts;
  if (version !== SCHEME_VERSION) {
    throw new Error(`Unknown encryption scheme version: ${version}`);
  }
  const key = loadKey();
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const enc = Buffer.from(encB64, "base64");
  if (iv.length !== IV_BYTES) throw new Error(`IV length mismatch: ${iv.length}`);
  if (tag.length !== TAG_BYTES) throw new Error(`Auth tag length mismatch: ${tag.length}`);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString("utf8");
}

/** قِناع آمن لِلعَرض في الواجهة (آخر 4 أحرف فَقط). للنُسخ الفارِغة ⇒ null. */
export function maskSecret(plaintextOrNull: string | null): string | null {
  if (!plaintextOrNull) return null;
  const len = plaintextOrNull.length;
  if (len <= 4) return "•".repeat(len);
  return "•".repeat(Math.min(len - 4, 8)) + plaintextOrNull.slice(-4);
}

/** Reset cache — لِلاختبارات فَقط. لا يُستَعمل في الإنتاج. */
export function __resetKeyCacheForTests() {
  cachedKey = null;
}
