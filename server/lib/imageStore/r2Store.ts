/**
 * R2ImageStore — سائق Cloudflare R2 الخاص لصور المنتجات.
 *
 * لا يمرّر ACL عاماً ولا يبني رابطاً عاماً؛ كل القراءة تمرّ لاحقاً عبر بوابة التطبيق التي
 * تتحقق من نشر المنتج. استعمال AWS SDK يمنع بناء توقيع S3 يدوياً.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "node:stream";
import {
  R2ResilienceController,
  ImageStoreClientAbortError,
  readR2ResilienceConfig,
  type R2Operation,
  type R2ResilienceConfig,
  type R2ResilienceEvent,
  type R2ResilienceSnapshot,
} from "./resilience";
import type { ImageStore, ImageStoreReadOptions, ObjectHead, PutResult } from "./types";

const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);
const MAX_OBJECT_BYTES = 25 * 1024 * 1024;
const BODY_READ_TIMEOUT_MS = 20_000;
const MIN_SIGNED_URL_SECONDS = 30;
const MAX_SIGNED_URL_SECONDS = 60 * 60;

export interface R2ImageStoreConfig {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

interface S3Executor {
  send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
}

export interface R2ImageStoreDependencies {
  client?: S3Executor;
  clientFactory?: (config: S3ClientConfig) => S3Executor;
  signedUrl?: (client: S3Executor, command: GetObjectCommand, options: { expiresIn: number }) => Promise<string>;
  resilience?: R2ResilienceController;
  resilienceConfig?: R2ResilienceConfig;
  onResilienceEvent?: (event: R2ResilienceEvent) => void;
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`ImageStore R2: المتغيّر ${name} مطلوب.`);
  return value;
}

function assertR2Config(config: R2ImageStoreConfig): void {
  if (!/^[a-f0-9]{32}$/.test(config.accountId)) {
    throw new Error("ImageStore R2: R2_ACCOUNT_ID غير صالح.");
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket)) {
    throw new Error("ImageStore R2: R2_IMAGE_BUCKET ليس اسم bucket صالحاً.");
  }
  if (!config.accessKeyId.trim() || !config.secretAccessKey.trim()) {
    throw new Error("ImageStore R2: اعتماد R2 غير مكتمل.");
  }
}

/** يقرأ عقد الاعتماد دون تسجيل أيّ قيمة حساسة. */
export function readR2ImageStoreConfig(env: NodeJS.ProcessEnv = process.env): R2ImageStoreConfig {
  const accountId = requiredEnv(env, "R2_ACCOUNT_ID");
  const bucket = requiredEnv(env, "R2_IMAGE_BUCKET");
  const config = {
    accountId,
    bucket,
    accessKeyId: requiredEnv(env, "R2_ACCESS_KEY_ID"),
    secretAccessKey: requiredEnv(env, "R2_SECRET_ACCESS_KEY"),
  };
  assertR2Config(config);
  return config;
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { name?: string; Code?: string; code?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === "NotFound" || e.name === "NoSuchKey" || e.Code === "NoSuchKey" || e.code === "NoSuchKey" || e.$metadata?.httpStatusCode === 404;
}

function assertSafeKey(key: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,1023}$/.test(key) || key.includes("..") || key.includes("//")) {
    throw new Error("ImageStore R2: مفتاح الكائن غير صالح.");
  }
}

function assertImagePayload(body: Buffer, contentType: string): void {
  if (!ALLOWED_IMAGE_TYPES.has(contentType.toLowerCase())) {
    throw new Error("ImageStore R2: نوع الصورة غير مسموح.");
  }
  if (body.length === 0 || body.length > MAX_OBJECT_BYTES) {
    throw new Error("ImageStore R2: حجم الصورة خارج الحد المسموح.");
  }
}

function toNodeStream(body: unknown): Readable {
  if (body instanceof Readable) return body;
  if (body && typeof body === "object" && "transformToWebStream" in body && typeof body.transformToWebStream === "function") {
    return Readable.fromWeb(body.transformToWebStream() as import("node:stream/web").ReadableStream);
  }
  if (body && typeof body === "object" && "getReader" in body && typeof body.getReader === "function") {
    return Readable.fromWeb(body as import("node:stream/web").ReadableStream);
  }
  throw new Error("ImageStore R2: جسم كائن غير صالح من المزوّد.");
}

function boundedBody(stream: Readable, maximumBytes: number, signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      stream.off("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };
    const settle = (error?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error === undefined) resolve(Buffer.concat(chunks, total));
      else reject(error);
    };
    const onData = (chunk: Buffer | Uint8Array | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (total > maximumBytes) {
        settle(Object.assign(new Error("ImageStore R2: جسم الكائن أكبر من metadata المعتمدة."), {
          name: "ImageStoreIntegrityError",
        }));
        stream.destroy();
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = () => settle();
    const onError = (error: unknown) => settle(error);
    const onClose = () => {
      if (!settled) settle(Object.assign(new Error("ImageStore R2: انقطع جسم الكائن."), { code: "ECONNRESET" }));
    };
    const onAbort = () => {
      settle(new ImageStoreClientAbortError());
      stream.destroy();
    };
    const timer = setTimeout(() => {
      settle(Object.assign(new Error("ImageStore R2: انتهت مهلة جسم الكائن."), { name: "TimeoutError" }));
      stream.destroy();
    }, BODY_READ_TIMEOUT_MS);
    timer.unref?.();
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
    stream.once("close", onClose);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * يخاطب endpoint الحساب الرسمي فقط، HTTPS حصراً، مع bucket خاص. لا يسمح هذا السائق بـACL
 * أو endpoint قابل للتبديل كي لا تتحول بيانات اعتماد R2 إلى طلبات خارجية غير مقصودة.
 */
export class R2ImageStore implements ImageStore {
  private readonly client: S3Executor;
  private readonly bucket: string;
  private readonly sign: NonNullable<R2ImageStoreDependencies["signedUrl"]>;
  private readonly resilience: R2ResilienceController;

  constructor(config: R2ImageStoreConfig, dependencies: R2ImageStoreDependencies = {}) {
    assertR2Config(config);
    this.bucket = config.bucket;
    const clientConfig: S3ClientConfig = {
      region: "auto",
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      maxAttempts: 3,
      requestHandler: {
        connectionTimeout: 5_000,
        requestTimeout: 20_000,
        socketTimeout: 15_000,
        throwOnRequestTimeout: true,
      },
    };
    this.client = dependencies.client ?? dependencies.clientFactory?.(clientConfig) ??
      (new S3Client(clientConfig) as unknown as S3Executor);
    this.sign = dependencies.signedUrl ?? ((client, command, options) =>
      getSignedUrl(client as S3Client, command, options));
    this.resilience = dependencies.resilience ?? new R2ResilienceController(
      dependencies.resilienceConfig ?? readR2ResilienceConfig(),
      { onEvent: dependencies.onResilienceEvent },
    );
  }

  /** لقطة محلية بلا bucket/key/اعتماد، صالحة للسجل والمراقبة فقط. */
  resilienceSnapshot(): R2ResilienceSnapshot {
    return this.resilience.snapshot();
  }

  recordPublicFallback(): void {
    this.resilience.recordPublicFallback();
  }

  private send(operation: R2Operation, command: unknown): Promise<unknown> {
    return this.resilience.run(operation, () => this.client.send(command));
  }

  async put(key: string, body: Buffer, contentType: string): Promise<PutResult> {
    assertSafeKey(key);
    assertImagePayload(body, contentType);
    const existing = await this.head(key);
    if (existing.exists) return { key, bytes: existing.bytes ?? body.length, existed: true };
    await this.send("put", new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: body,
      ContentType: contentType.toLowerCase(),
      // لا ACL: bucket خاص، ولا قراءة خارج بوابة المنتج/الكشك المصادق.
    }));
    return { key, bytes: body.length, existed: false };
  }

  async head(key: string): Promise<ObjectHead> {
    assertSafeKey(key);
    try {
      const result = await this.send("head", new HeadObjectCommand({ Bucket: this.bucket, Key: key })) as { ContentLength?: number };
      return { exists: true, ...(typeof result.ContentLength === "number" ? { bytes: result.ContentLength } : {}) };
    } catch (error) {
      if (isNotFound(error)) return { exists: false };
      throw error;
    }
  }

  async getStream(key: string): Promise<Readable | null> {
    assertSafeKey(key);
    try {
      return await this.resilience.runStream("get", async () => {
        const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key })) as { Body?: unknown };
        if (!result.Body) throw new Error("ImageStore R2: الكائن الموجود بلا جسم.");
        return toNodeStream(result.Body);
      });
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async getBuffer(key: string, expectedBytes: number, options: ImageStoreReadOptions = {}): Promise<Buffer | null> {
    assertSafeKey(key);
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || expectedBytes > MAX_OBJECT_BYTES) {
      throw Object.assign(new Error("ImageStore R2: حد القراءة غير صالح."), { name: "ImageStoreIntegrityError" });
    }
    try {
      return await this.resilience.run("get", async () => {
        if (options.signal?.aborted) throw new ImageStoreClientAbortError();
        let result: { Body?: unknown; ContentLength?: number };
        try {
          result = await this.client.send(
            new GetObjectCommand({ Bucket: this.bucket, Key: key }),
            { abortSignal: options.signal },
          ) as { Body?: unknown; ContentLength?: number };
        } catch (error) {
          if (options.signal?.aborted) throw new ImageStoreClientAbortError();
          throw error;
        }
        const typedResult = result as {
          Body?: unknown;
          ContentLength?: number;
        };
        if (typeof typedResult.ContentLength !== "number" || !Number.isSafeInteger(typedResult.ContentLength) ||
            typedResult.ContentLength !== expectedBytes) {
          const body = typedResult.Body ? toNodeStream(typedResult.Body) : null;
          body?.destroy();
          throw Object.assign(new Error("ImageStore R2: حجم الكائن لا يطابق metadata المعتمدة."), {
            name: "ImageStoreIntegrityError",
          });
        }
        if (!typedResult.Body) throw new Error("ImageStore R2: الكائن الموجود بلا جسم.");
        const body = await boundedBody(toNodeStream(typedResult.Body), expectedBytes, options.signal);
        if (body.length !== expectedBytes) {
          throw Object.assign(new Error("ImageStore R2: جسم الكائن أقصر من metadata المعتمدة."), {
            name: "ImageStoreIntegrityError",
          });
        }
        return body;
      });
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    try {
      await this.send("delete", new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  async signedUrl(key: string, expiresSec = 300): Promise<string> {
    assertSafeKey(key);
    if (!Number.isInteger(expiresSec) || expiresSec < MIN_SIGNED_URL_SECONDS || expiresSec > MAX_SIGNED_URL_SECONDS) {
      throw new Error("ImageStore R2: مدة الرابط الموقّع يجب أن تكون بين 30 و3600 ثانية.");
    }
    return this.sign(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: expiresSec });
  }
}
