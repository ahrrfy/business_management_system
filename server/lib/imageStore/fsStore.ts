/**
 * FsImageStore — سائق نظام-ملفات لـImageStore، **للتطوير/الجلسة حصراً** (لا قرص VPS مشترك).
 * كتابة ذرّية (ملفّ مؤقّت ثم rename) + متعادِلة (كائن موجود ⇒ لا كتابة فوقية) + حصانة path-traversal.
 */
import { randomUUID } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import type { ImageStore, ObjectHead, PutResult } from "./types";

export class FsImageStore implements ImageStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private full(key: string): string {
    const resolved = path.resolve(this.root, key);
    // المفاتيح معنونة-بالمحتوى فلا تحمل «..» عادةً — نحصّن مع ذلك ضدّ الخروج من الجذر.
    if (resolved !== this.root && !resolved.startsWith(this.root + path.sep)) {
      throw new Error(`FsImageStore: مفتاح خارج الجذر مرفوض: ${key}`);
    }
    return resolved;
  }

  async put(key: string, body: Buffer, _contentType: string): Promise<PutResult> {
    const full = this.full(key);
    const existing = await this.head(key);
    if (existing.exists) return { key, bytes: existing.bytes ?? body.length, existed: true };
    await fs.mkdir(path.dirname(full), { recursive: true });
    const tmp = `${full}.tmp-${randomUUID()}`;
    await fs.writeFile(tmp, body);
    await fs.rename(tmp, full); // ذرّيّ داخل نفس نظام الملفات
    return { key, bytes: body.length, existed: false };
  }

  async head(key: string): Promise<ObjectHead> {
    try {
      const st = await fs.stat(this.full(key));
      return { exists: true, bytes: st.size };
    } catch {
      return { exists: false };
    }
  }

  async getStream(key: string): Promise<Readable | null> {
    if (!(await this.head(key)).exists) return null;
    return createReadStream(this.full(key));
  }

  async delete(key: string): Promise<void> {
    try {
      await fs.unlink(this.full(key));
    } catch {
      /* غياب الكائن ليس خطأً (حذف متعادِل) */
    }
  }
}
