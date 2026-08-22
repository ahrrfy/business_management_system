import { Check, MessageSquare, Star, X } from "lucide-react";
import { useState } from "react";

import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";

type ReviewStatus = "PENDING" | "APPROVED" | "REJECTED";
const STATUS_AR: Record<ReviewStatus, string> = { PENDING: "بانتظار الاعتماد", APPROVED: "منشورة", REJECTED: "مرفوضة" };

export default function StoreProductReviewManager() {
  const [status, setStatus] = useState<ReviewStatus>("PENDING");
  const utils = trpc.useUtils();
  const reviews = trpc.storeAdmin.reviews.list.useQuery({ status });
  const moderate = trpc.storeAdmin.reviews.moderate.useMutation({
    onSuccess: async () => { await utils.storeAdmin.reviews.list.invalidate(); notify.ok("تم تحديث حالة المراجعة"); },
    onError: (error) => notify.err(error),
  });
  return <div className="mx-auto max-w-6xl space-y-4 pb-8"><PageHeader title="مراجعات العملاء" description="تظهر للمتسوقين فقط مراجعات العملاء الذين استلموا الطلبات وبعد اعتمادها من المكتبة."/><div className="flex flex-wrap gap-2">{(["PENDING", "APPROVED", "REJECTED"] as const).map((value) => <Button key={value} onClick={() => setStatus(value)} size="sm" variant={status === value ? "default" : "outline"}>{STATUS_AR[value]}</Button>)}</div><Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><MessageSquare className="size-4"/>{STATUS_AR[status]}</CardTitle></CardHeader><CardContent className="space-y-3">{reviews.isLoading && <div className="py-10 text-center text-sm text-muted-foreground">جار تحميل المراجعات…</div>}{(reviews.data ?? []).map((review) => <div key={review.id} className="rounded-xl border bg-card p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="font-bold">{review.productName}</div><div className="mt-1 text-xs text-muted-foreground">العميل: {review.customerName} · {new Date(review.createdAt).toLocaleDateString("en-GB")}</div></div><Badge>{STATUS_AR[review.status]}</Badge></div><div className="mt-3 flex items-center gap-1">{[1,2,3,4,5].map((star) => <Star key={star} className={`size-4 ${star <= review.rating ? "fill-amber-400 text-amber-400" : "text-muted-foreground/30"}`}/>)}</div><p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-foreground/85">{review.comment}</p>{status === "PENDING" && <div className="mt-4 flex justify-end gap-2"><Button disabled={moderate.isPending} onClick={() => moderate.mutate({ reviewId: review.id, status: "REJECTED" })} size="sm" variant="outline"><X className="size-4"/>رفض</Button><Button disabled={moderate.isPending} onClick={() => moderate.mutate({ reviewId: review.id, status: "APPROVED" })} size="sm"><Check className="size-4"/>اعتماد ونشر</Button></div>}</div>)}{!reviews.isLoading && !reviews.data?.length && <div className="py-12 text-center text-sm text-muted-foreground"><MessageSquare className="mx-auto mb-2 size-6"/>لا توجد مراجعات في هذه الحالة حالياً.</div>}</CardContent></Card></div>;
}
