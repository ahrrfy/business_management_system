import { Building2, FileText, Phone, Send } from "lucide-react";
import { useState } from "react";

import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";

type Status = "PENDING" | "CONTACTED" | "QUOTED" | "CLOSED" | "CANCELLED";

const STATUS_LABEL: Record<Status, string> = {
  PENDING: "وارد جديد",
  CONTACTED: "تم التواصل",
  QUOTED: "أُرسل عرض رسمي",
  CLOSED: "مكتمل",
  CANCELLED: "ملغى",
};
const TYPE_LABEL: Record<string, string> = {
  BULK: "طلب كمية",
  CUSTOM_PRINT: "طباعة وتخصيص",
  BUSINESS: "شركة أو مكتب",
  GENERAL: "طلب مبيعات",
};
const NEXT_STATUS: Partial<Record<Status, Status>> = {
  PENDING: "CONTACTED",
  CONTACTED: "QUOTED",
  QUOTED: "CLOSED",
};

export default function StoreQuoteRequests() {
  const [status, setStatus] = useState<Status | "ALL">("PENDING");
  const utils = trpc.useUtils();
  const requests = trpc.storeAdmin.quoteRequests.list.useQuery(
    status === "ALL" ? undefined : { status },
  );
  const update = trpc.storeAdmin.quoteRequests.setStatus.useMutation({
    onSuccess: async () => {
      await utils.storeAdmin.quoteRequests.list.invalidate();
      notify.ok("تم تحديث متابعة طلب عرض السعر");
    },
    onError: (error) => notify.err(error),
  });

  return (
    <div className="mx-auto max-w-6xl space-y-4 pb-8">
      <PageHeader
        title="طلبات عروض الأسعار"
        description="وارد الشركات والكميات والطباعة. لا يحجز هذا الوارد المخزون ولا يثبت سعراً؛ أنشئ العرض الرسمي بعد المراجعة."
        icon={<FileText aria-hidden className="size-5" />}
      />
      <div className="flex flex-wrap gap-2">
        {(["PENDING", "CONTACTED", "QUOTED", "CLOSED", "CANCELLED", "ALL"] as const).map((value) => (
          <Button key={value} onClick={() => setStatus(value)} size="sm" variant={status === value ? "default" : "outline"}>
            {value === "ALL" ? "الكل" : STATUS_LABEL[value]}
          </Button>
        ))}
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><Building2 className="size-4" />طلبات العملاء</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {requests.isLoading && <div className="py-10 text-center text-sm text-muted-foreground">جار تحميل الطلبات…</div>}
          {(requests.data ?? []).map((request) => {
            const next = NEXT_STATUS[request.status as Status];
            return (
              <Card key={request.id} className="gap-0 py-0 shadow-none">
                <CardContent className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2"><span className="font-bold tracking-wider" dir="ltr">{request.requestNumber}</span><Badge>{TYPE_LABEL[request.requestType] ?? request.requestType}</Badge></div>
                    <div className="mt-1 text-xs text-muted-foreground">{request.customerName ?? "عميل"}{request.companyName ? ` · ${request.companyName}` : ""}{request.governorate ? ` · ${request.governorate}` : ""}</div>
                  </div>
                  <Badge variant="outline">{STATUS_LABEL[request.status as Status]}</Badge>
                </div>
                {request.customerPhone && <div className="mt-3 flex items-center gap-1.5 text-sm"><Phone className="size-4 text-muted-foreground" /><span dir="ltr">{request.customerPhone}</span><span className="text-xs text-muted-foreground">({request.contactPreference === "WHATSAPP" ? "واتساب" : "اتصال"})</span></div>}
                <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-foreground/85">{request.customerNote}</p>
                <div className="mt-3 rounded-lg bg-muted/40 p-3 text-sm">
                  {request.items.map((item, index) => <div key={`${item.productName}-${index}`} className="py-0.5">{item.productName}{item.variantLabel ? ` — ${item.variantLabel}` : ""} · {item.quantity} {item.unitName}</div>)}
                </div>
                {request.staffNote && <p className="mt-3 text-xs leading-5 text-muted-foreground">ملاحظة الفريق: {request.staffNote}</p>}
                {next && <div className="mt-4 flex justify-end"><Button disabled={update.isPending} onClick={() => update.mutate({ requestId: request.id, status: next })} size="sm"><Send className="size-4" />{next === "CONTACTED" ? "تسجيل التواصل" : next === "QUOTED" ? "تسجيل إرسال العرض الرسمي" : "إغلاق الطلب"}</Button></div>}
                </CardContent>
              </Card>
            );
          })}
          {!requests.isLoading && !requests.data?.length && <div className="py-12 text-center text-sm text-muted-foreground"><FileText className="mx-auto mb-2 size-6" />لا توجد طلبات في هذه الحالة حالياً.</div>}
        </CardContent>
      </Card>
    </div>
  );
}
