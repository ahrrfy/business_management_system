// مستندات الأصل (رفع/حذف) — صورة base64 مضغوطة في MEDIUMTEXT (لا بنية S3 في النظام).
// التخويل عبر بوّابة الراوتر assetWrite (requireModule "assets","FULL")، ثم يُفرض نطاق الفرع
// داخل الخدمة دفاعاً في العمق: مدير الفرع لا يرفع/يحذف مستند أصل من فرع آخر.
// القراءة تبقى عبر getAsset (a.docs). كل كتابة تُدقَّق في الراوتر (logAudit).
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { assetDocuments } from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { companyBranchScope } from "../companyBranchScope";
import { type Actor, withTx } from "../tx";
import { loadForUpdate } from "./helpers";

export interface AddAssetDocumentInput {
  title: string;
  dataUrl: string;
}

export async function addAssetDocument(assetId: number, input: AddAssetDocumentInput, actor: Actor) {
  const scope = companyBranchScope(actor);
  return withTx(async (tx) => {
    await loadForUpdate(tx, assetId, scope);
    const title = input.title.trim().slice(0, 255);
    const res = await tx.insert(assetDocuments).values({ assetId, title, dataUrl: input.dataUrl });
    return { id: extractInsertId(res), assetId, title };
  });
}

export async function deleteAssetDocument(docId: number, actor: Actor) {
  const scope = companyBranchScope(actor);
  return withTx(async (tx) => {
    const [candidate] = await tx
      .select({ id: assetDocuments.id, assetId: assetDocuments.assetId })
      .from(assetDocuments)
      .where(eq(assetDocuments.id, docId))
      .limit(1);
    if (!candidate) throw new TRPCError({ code: "NOT_FOUND", message: "المستند غير موجود" });

    // Lock the parent asset under the authenticated scope before deleting the child.
    // This closes the race where an admin moves the asset to another branch between
    // the authorization read and the delete.
    await loadForUpdate(tx, Number(candidate.assetId), scope);
    const [doc] = await tx
      .select({ id: assetDocuments.id })
      .from(assetDocuments)
      .where(and(eq(assetDocuments.id, docId), eq(assetDocuments.assetId, Number(candidate.assetId))))
      .for("update")
      .limit(1);
    if (!doc) throw new TRPCError({ code: "NOT_FOUND", message: "المستند غير موجود" });
    await tx
      .delete(assetDocuments)
      .where(and(eq(assetDocuments.id, docId), eq(assetDocuments.assetId, Number(candidate.assetId))));
    return { ok: true as const, assetId: Number(candidate.assetId) };
  });
}
