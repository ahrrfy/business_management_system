// بنك جهات الاتصال (S3، T3.2) — تسجيل يدوي لموافقة/رفض تسويق واتساب للعميل (customers.waConsent،
// هجرة 0108). المصدر يُثبَّت 'MANUAL' دائماً هنا (التقاط تلقائي لكلمات إلغاء الاشتراك من الوارد
// مصدرٌ آخر خارج هذا المسار — AUTO_KEYWORD، راجع commit da7e3cf).
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { customers } from "../../../drizzle/schema";
import type { Actor } from "../tx";
import { withTx } from "../tx";

export type WaConsentValue = "UNKNOWN" | "OPTED_IN" | "OPTED_OUT";

export interface SetWaConsentInput {
  customerId: number;
  consent: WaConsentValue;
}

export async function setWaConsent(input: SetWaConsentInput, _actor: Actor) {
  return withTx(async (tx) => {
    const c = (await tx.select({ id: customers.id }).from(customers).where(eq(customers.id, input.customerId)).for("update").limit(1))[0];
    if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "العميل غير موجود" });
    await tx
      .update(customers)
      .set({ waConsent: input.consent, waConsentAt: new Date(), waConsentSource: "MANUAL" })
      .where(eq(customers.id, input.customerId));
    return { customerId: input.customerId, waConsent: input.consent };
  });
}
