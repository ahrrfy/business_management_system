// مغلّف تنبيهات موحّد فوق sonner — بديل عن رسائل inline المتناثرة في كل صفحة.
// الاستعمال:
//   import { notify, errMsg } from "@/lib/notify";
//   notify.ok("تم الحفظ");
//   create.mutate(data, { onError: (e) => notify.err(e) });   // يستخرج رسالة عربية تلقائياً
//   await notify.promise(p, { loading: "جارٍ…", success: "تم", error: "فشل" });
import { toast } from "sonner";
import { TRPCClientError } from "@trpc/client";

/** يستخرج رسالة عربية مفهومة من أي خطأ (tRPC / Error / نص). */
export function errMsg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof TRPCClientError) {
    // رسائل الخادم عربية أصلاً (server/services/*). نأخذها كما هي إن وُجدت.
    const zod = e.data?.zodError?.fieldErrors;
    if (zod) {
      const first = Object.values(zod).flat().filter(Boolean)[0];
      if (first) return String(first);
    }
    return e.message || "حدث خطأ غير متوقّع.";
  }
  if (e instanceof Error) return e.message || "حدث خطأ غير متوقّع.";
  return "حدث خطأ غير متوقّع.";
}

export const notify = {
  /** نجاح — مدّة قصيرة (٣ث). */
  ok(message: string, description?: string) {
    return toast.success(message, { description, duration: 3000 });
  },
  /** خطأ — مدّة أطول (٦ث) ويقبل أي شكل خطأ. */
  err(error: unknown, description?: string) {
    return toast.error(errMsg(error), { description, duration: 6000 });
  },
  /** معلومة محايدة. */
  info(message: string, description?: string) {
    return toast(message, { description, duration: 4000 });
  },
  /** تحذير. */
  warn(message: string, description?: string) {
    return toast.warning(message, { description, duration: 5000 });
  },
  /** يربط دورة حياة وعد (loading → success/error) بتنبيه واحد. */
  promise<T>(
    promise: Promise<T>,
    msgs: { loading: string; success: string | ((data: T) => string); error?: string | ((e: unknown) => string) }
  ) {
    return toast.promise(promise, {
      loading: msgs.loading,
      success: msgs.success,
      error: (e) => (typeof msgs.error === "function" ? msgs.error(e) : msgs.error ?? errMsg(e)),
    });
  },
};
