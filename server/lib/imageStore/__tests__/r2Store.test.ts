import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetImageStoreForTest, getImageStore } from "..";
import { R2ImageStore, readR2ImageStoreConfig } from "../r2Store";

const KEY = "company/p/ab/abcdef.png";
const config = { accountId: "a".repeat(32), bucket: "private-product-images", accessKeyId: "test-key", secretAccessKey: "test-secret" };

function missing(): Error {
  return Object.assign(new Error("missing"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
}

describe("R2ImageStore", () => {
  it("PUT متعادِل ولا يرسل ACL عاماً", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(missing())
      .mockResolvedValueOnce({});
    const store = new R2ImageStore(config, { client: { send } });

    await expect(store.put(KEY, Buffer.from([1, 2, 3]), "image/png")).resolves.toEqual({ key: KEY, bytes: 3, existed: false });
    expect(send.mock.calls[0][0]).toBeInstanceOf(HeadObjectCommand);
    expect(send.mock.calls[1][0]).toBeInstanceOf(PutObjectCommand);
    expect((send.mock.calls[1][0] as PutObjectCommand).input).toMatchObject({ Bucket: config.bucket, Key: KEY, ContentType: "image/png" });
    expect((send.mock.calls[1][0] as PutObjectCommand).input).not.toHaveProperty("ACL");

    const alreadyThere = new R2ImageStore(config, { client: { send: vi.fn().mockResolvedValue({ ContentLength: 9 }) } });
    await expect(alreadyThere.put(KEY, Buffer.from([1, 2, 3]), "image/png")).resolves.toEqual({ key: KEY, bytes: 9, existed: true });
  });

  it("يحوّل الغياب فقط إلى null/false ويعيد البث", async () => {
    const stream = Readable.from([Buffer.from("image")]);
    const send = vi.fn()
      .mockResolvedValueOnce({ ContentLength: 5 })
      .mockResolvedValueOnce({ Body: stream })
      .mockRejectedValueOnce(missing())
      .mockRejectedValueOnce(missing());
    const store = new R2ImageStore(config, { client: { send } });

    await expect(store.head(KEY)).resolves.toEqual({ exists: true, bytes: 5 });
    const actual = await store.getStream(KEY);
    const chunks: Buffer[] = [];
    for await (const chunk of actual!) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe("image");
    await expect(store.getStream(KEY)).resolves.toBeNull();
    await expect(store.delete(KEY)).resolves.toBeUndefined();
    expect(send.mock.calls[1][0]).toBeInstanceOf(GetObjectCommand);
    expect(send.mock.calls[3][0]).toBeInstanceOf(DeleteObjectCommand);
  });

  it("يرفض مفتاحاً أو نوعاً أو حجماً غير صالحين قبل أي شبكة", async () => {
    const send = vi.fn();
    const store = new R2ImageStore(config, { client: { send } });
    await expect(store.put("../escape", Buffer.from([1]), "image/png")).rejects.toThrow(/مفتاح/);
    await expect(store.put(KEY, Buffer.from([1]), "text/html")).rejects.toThrow(/نوع/);
    await expect(store.put(KEY, Buffer.alloc(25 * 1024 * 1024 + 1), "image/png")).rejects.toThrow(/حجم/);
    expect(send).not.toHaveBeenCalled();
  });

  it("يرفض اعتماداً مباشراً لا يستطيع أن يوجّه الأسرار خارج R2", () => {
    expect(() => new R2ImageStore({ ...config, accountId: "invalid.endpoint" })).toThrow(/ACCOUNT_ID/);
    expect(() => new R2ImageStore({ ...config, bucket: "INVALID_" })).toThrow(/bucket/);
  });

  it("يقيّد مدة الرابط الموقّع ويستعمل bucket الخاص", async () => {
    const signedUrl = vi.fn().mockResolvedValue("https://signed.example/object");
    const store = new R2ImageStore(config, { client: { send: vi.fn() }, signedUrl });
    await expect(store.signedUrl(KEY, 29)).rejects.toThrow(/30/);
    await expect(store.signedUrl(KEY, 60)).resolves.toBe("https://signed.example/object");
    expect((signedUrl.mock.calls[0][1] as GetObjectCommand).input).toMatchObject({ Bucket: config.bucket, Key: KEY });
  });
});

describe("readR2ImageStoreConfig", () => {
  it("يفشل بلا اعتماد مكتمل ولا يعيد السر ضمن الخطأ", () => {
    expect(() => readR2ImageStoreConfig({ R2_ACCOUNT_ID: "a".repeat(32), R2_IMAGE_BUCKET: "private-images" })).toThrow("R2_ACCESS_KEY_ID");
    expect(() => readR2ImageStoreConfig({ R2_ACCOUNT_ID: "a".repeat(32), R2_IMAGE_BUCKET: "INVALID_" , R2_ACCESS_KEY_ID: "key", R2_SECRET_ACCESS_KEY: "do-not-leak" })).toThrow(/bucket/);
  });
});

describe("getImageStore production guard", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    __resetImageStoreForTest();
  });

  it("يرفض التخزين المحلي في الإنتاج بدلاً من السقوط الصامت", () => {
    process.env.NODE_ENV = "production";
    process.env.IMAGE_STORE_DRIVER = "fs";
    __resetImageStoreForTest();
    expect(() => getImageStore()).toThrow(/محظور في الإنتاج/);
  });

  it("يرفض R2 الناقص قبل إنشاء أي عميل", () => {
    process.env.NODE_ENV = "production";
    process.env.IMAGE_STORE_DRIVER = "r2";
    delete process.env.R2_ACCOUNT_ID;
    __resetImageStoreForTest();
    expect(() => getImageStore()).toThrow(/R2_ACCOUNT_ID/);
  });
});
