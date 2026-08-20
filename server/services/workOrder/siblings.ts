/**
 * **إخوةُ الطلب الواحد** — حارسٌ مشتركٌ لكلّ مخرجٍ يُخرج بضاعةً من المكتبة (٢٠/٨).
 *
 * سلّةُ الاستقبال الواحدة تُنتج فاتورةَ بضاعةٍ **وأوامرَ شغل** معاً، والزبون يرى **طلباً
 * واحداً**. فإخراجُ جزءٍ منه وتركُ باقيه يعني أنّ الزبون يستلم نصف طلبه ولا شاشةَ تقول ذلك
 * لأحد — يتّصل غاضباً، والاستقبالُ لا يعرف أنّ طلبه خرج ناقصاً أصلاً.
 *
 * **لماذا مشتركٌ ولماذا بـ`draftId`** (تصويب مراجعة Codex): كان الفحصُ في `dispatchInvoiceInTx`
 * وحده ويصل إلى المسوّدة عبر `committedInvoiceId`. وفيه ثقبان:
 *  · مسوّدةٌ **كلُّها أوامرُ شغل** لا تُنتج فاتورةَ بضاعةٍ أصلاً ⇒ `committedInvoiceId = NULL`
 *    ⇒ الحارسُ لا يُستدعى **أبداً** وهي أكثرُ الحالات عرضةً للانقسام.
 *  · و`workOrders.deliver` و`delivery.dispatch` مخرجان آخران لا يمرّان به إطلاقاً.
 * فالمفتاحُ الصحيح `workOrders.draftId` مباشرةً، والحارسُ يُستدعى من المخارج الثلاثة.
 */
import { TRPCError } from "@trpc/server";
import { and, eq, ne, notInArray } from "drizzle-orm";
import { workOrders } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { PARTIAL_DISPATCH_MARKER as PARTIAL_SIBLING_MARKER } from "@shared/partialDispatch";

/** حالاتٌ تعني «انتهى دورُ هذا الأخ» — لا تعوق خروج غيره. */
const SETTLED_SIBLING_STATUSES = ["READY", "DELIVERED", "CANCELLED"] as const;

export interface UnreadySibling {
  id: number;
  orderNumber: string;
  status: string;
}

/**
 * إخوةُ الأمر (أو الفاتورة) الذين لم يجهزوا بعد. يُرجع `[]` حين لا مسوّدة جامعة —
 * وهي الحالةُ الغالبة، فيبقى المسارُ كما كان تماماً بلا استعلامٍ إضافيّ.
 */
export async function unreadySiblingsOfDraft(
  tx: Tx,
  draftId: number | null | undefined,
  excludeWorkOrderId?: number | null,
): Promise<UnreadySibling[]> {
  if (draftId == null) return [];
  const conds = [
    eq(workOrders.draftId, Number(draftId)),
    notInArray(workOrders.status, [...SETTLED_SIBLING_STATUSES]),
  ];
  if (excludeWorkOrderId != null) conds.push(ne(workOrders.id, Number(excludeWorkOrderId)));
  const rows = await tx
    .select({ id: workOrders.id, orderNumber: workOrders.orderNumber, status: workOrders.status })
    .from(workOrders)
    .where(and(...conds))
    .limit(20);
  return rows.map((r) => ({ id: Number(r.id), orderNumber: String(r.orderNumber), status: String(r.status) }));
}

/**
 * يفشل **مغلقاً** إن بقي أخٌ لم يجهز، ما لم يُقرّ المستخدم الإرسال الجزئيّ صراحةً.
 * يُرجع الإخوةَ غير الجاهزين كي يكتبهم المستدعي في حدث/سجلّ الإجراء — وإلّا صار
 * «من أذن بخروج نصف الطلب؟» سؤالاً بلا جواب.
 */
export async function assertSiblingsReady(
  tx: Tx,
  opts: {
    draftId: number | null | undefined;
    excludeWorkOrderId?: number | null;
    confirmed?: boolean;
    /** يظهر في الرسالة: «إرسال»/«تسليم» — الفعلُ الذي يوشك أن يقع. */
    action: "dispatch" | "deliver";
  },
): Promise<UnreadySibling[]> {
  const siblings = await unreadySiblingsOfDraft(tx, opts.draftId, opts.excludeWorkOrderId);
  if (siblings.length === 0 || opts.confirmed === true) return siblings;
  const names = siblings.slice(0, 3).map((r) => r.orderNumber).join("، ");
  const more = siblings.length > 3 ? "…" : "";
  const verb = opts.action === "deliver" ? "تسليمُ هذا الجزء" : "إرسالُ الفاتورة";
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message:
      `الطلب نفسه يحوي ${siblings.length} ${PARTIAL_SIBLING_MARKER} بعد (${names}${more}) — `
      + `${verb} الآن يُخرج جزءاً من الطلب ويترك باقيه. أكمِلها أوّلاً، أو أقرّ الإرسال الجزئيّ صراحةً.`,
  });
}
