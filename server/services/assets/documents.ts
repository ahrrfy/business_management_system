// مستندات الأصل (رفع/حذف) — صورة base64 مضغوطة في MEDIUMTEXT (لا بنية S3 في النظام).
// التخويل عبر بوّابة الراوتر assetWrite (requireModule "assets","FULL") — والأصول محورٌ مديريّ
// عابرٌ للفروع (admin/manager، غير مُقيَّد بـscopedBranch؛ نظير addMaintenance بلا عزل فرع).
// القراءة تبقى عبر getAsset (a.docs). كل كتابة تُدقَّق في الراوتر (logAudit).
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { assetDocuments, fixedAssets } from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { withTx } from "../tx";

export interface AddAssetDocumentInput {
  title: string;
  dataUrl: string;
}

export async function addAssetDocument(assetId: number, input: AddAssetDocumentInput) {
  return withTx(async (tx) => {
    const [a] = await tx.select({ id: fixedAssets.id }).from(fixedAssets).where(eq(fixedAssets.id, assetId)).limit(1);
    if (!a) throw new TRPCError({ code: "NOT_FOUND", message: "الأصل غير موجود" });
    const title = input.title.trim().slice(0, 255);
    const res = await tx.insert(assetDocuments).values({ assetId, title, dataUrl: input.dataUrl });
    return { id: extractInsertId(res), assetId, title };
  });
}

export async function deleteAssetDocument(docId: number) {
  return withTx(async (tx) => {
    const [doc] = await tx
      .select({ id: assetDocuments.id, assetId: assetDocuments.assetId })
      .from(assetDocuments)
      .where(eq(assetDocuments.id, docId))
      .limit(1);
    if (!doc) throw new TRPCError({ code: "NOT_FOUND", message: "المستند غير موجود" });
    await tx.delete(assetDocuments).where(eq(assetDocuments.id, docId));
    return { ok: true as const, assetId: Number(doc.assetId) };
  });
}
