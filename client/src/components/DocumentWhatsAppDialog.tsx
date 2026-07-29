import { useEffect, useMemo, useRef, useState } from "react";
import { Download, FileText, Loader2, MessageCircle, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { notify } from "@/lib/notify";
import { openWhatsApp } from "@/lib/whatsapp";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

interface Props {
  kind: "INVOICE" | "QUOTATION";
  documentId: number;
  documentNumber: string;
  customerName?: string | null;
  defaultPhone?: string | null;
  fallbackMessage: string;
  autoOpen?: boolean;
}

const STATUS_LABEL: Record<string, string> = {
  QUEUED: "قيد الانتظار",
  SENDING: "جارٍ إنشاء ورفع الملف",
  SENT: "تم الإرسال",
  DELIVERED: "تم التسليم",
  READ: "تمت القراءة",
  FAILED: "فشل الإرسال",
  CANCELLED: "أُلغي الإرسال",
};

function downloadBase64Pdf(filename: string, base64: string): void {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function DocumentWhatsAppDialog({
  kind,
  documentId,
  documentNumber,
  customerName,
  defaultPhone,
  fallbackMessage,
  autoOpen = false,
}: Props) {
  const [open, setOpen] = useState(autoOpen);
  const [phone, setPhone] = useState(defaultPhone ?? "");
  const [caption, setCaption] = useState(
    `${kind === "INVOICE" ? "فاتورة المبيعات" : "عرض السعر"} رقم ${documentNumber}`,
  );
  const [outboxId, setOutboxId] = useState<number | null>(null);
  const notifiedStatusRef = useRef<string | null>(null);
  const debouncedPhone = useDebouncedValue(phone, 350);

  useEffect(() => {
    if (!autoOpen) return;
    setOpen(true);
    const url = new URL(window.location.href);
    url.searchParams.delete("share");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [autoOpen]);

  const readiness = trpc.documentDelivery.readiness.useQuery(
    { kind, documentId, phone: debouncedPhone || null },
    { enabled: open, staleTime: 10_000 },
  );
  const downloadPdf = trpc.documentDelivery.downloadPdf.useMutation({
    onSuccess: (result) => downloadBase64Pdf(result.filename, result.bytesBase64),
    onError: (error) => notify.err(error),
  });
  const sendPdf = trpc.documentDelivery.sendWhatsAppPdf.useMutation({
    onSuccess: (result) => {
      setOutboxId(result.outboxId);
      notifiedStatusRef.current = null;
      notify.info("تمت إضافة ملف PDF إلى طابور الإرسال.");
    },
    onError: (error) => notify.err(error),
  });
  const status = trpc.documentDelivery.sendStatus.useQuery(
    { outboxId: outboxId ?? 0 },
    {
      enabled: outboxId != null && open,
      refetchInterval: (query) => {
        const value = query.state.data?.status;
        if (value === "QUEUED" || value === "SENDING") return 1_200;
        if (value === "SENT" || value === "DELIVERED") return 5_000;
        return false;
      },
    },
  );

  useEffect(() => {
    const value = status.data?.status;
    if (!value || notifiedStatusRef.current === value) return;
    if (value === "SENT" || value === "DELIVERED" || value === "READ") {
      notifiedStatusRef.current = value;
      if (value === "SENT") notify.ok("تم إرسال ملف PDF عبر واتساب.");
    } else if (value === "FAILED") {
      notifiedStatusRef.current = value;
      notify.err(status.data?.lastError ?? "فشل إرسال ملف PDF عبر واتساب.");
    }
  }, [status.data?.lastError, status.data?.status]);

  const ready = readiness.data;
  const busy = downloadPdf.isPending || sendPdf.isPending;
  const statusValue = status.data?.status ?? null;
  const isSending = statusValue === "QUEUED" || statusValue === "SENDING";
  const modeLabel = useMemo(() => {
    if (!ready) return null;
    if (ready.mode === "SESSION") return "إرسال مباشر ضمن نافذة المحادثة";
    if (ready.mode === "TEMPLATE") return `إرسال بقالب Meta المعتمد (${ready.templateName})`;
    return "الإرسال التلقائي غير متاح";
  }, [ready]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) {
          setPhone(defaultPhone ?? "");
          setOutboxId(null);
          notifiedStatusRef.current = null;
        }
      }}
    >
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5 border-emerald-300/60 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
        >
          <MessageCircle aria-hidden className="size-4" />
          إرسال PDF عبر واتساب
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl" dir="rtl">
        <DialogHeader>
          <DialogTitle>إرسال المستند عبر واتساب</DialogTitle>
          <DialogDescription>
            راجع الرقم والملف والرسالة قبل الإرسال. لن تحتاج إلى تنزيل الملف أو إرفاقه يدوياً.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-center gap-3 rounded-xl border bg-muted/30 p-3">
            <div className="grid size-11 shrink-0 place-items-center rounded-lg bg-rose-50 text-rose-700">
              <FileText aria-hidden className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-bold">{ready?.filename ?? `${documentNumber}.pdf`}</div>
              <div className="text-xs text-muted-foreground">
                {customerName || "عميل نقدي"} · PDF رسمي A4
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => downloadPdf.mutate({ kind, documentId })}
            >
              {downloadPdf.isPending ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Download aria-hidden className="size-4" />}
              معاينة/تنزيل
            </Button>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`wa-phone-${kind}-${documentId}`}>رقم واتساب العميل</Label>
            <Input
              id={`wa-phone-${kind}-${documentId}`}
              dir="ltr"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              placeholder="+9647701234567"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`wa-caption-${kind}-${documentId}`}>الرسالة المرفقة</Label>
            <Textarea
              id={`wa-caption-${kind}-${documentId}`}
              value={caption}
              onChange={(event) => setCaption(event.target.value)}
              rows={3}
              maxLength={1024}
            />
          </div>

          <div
            className={cn(
              "rounded-lg border px-3 py-2 text-sm",
              readiness.isFetching
                ? "bg-muted/30 text-muted-foreground"
                : ready?.automaticAvailable
                  ? "border-emerald-300/50 bg-emerald-50 text-emerald-800"
                  : "border-amber-300/50 bg-amber-50 text-amber-800",
            )}
          >
            {readiness.isFetching
              ? "جارٍ التحقق من جاهزية واتساب…"
              : ready?.automaticAvailable
                ? modeLabel
                : ready?.reason ?? "تعذّر التحقق من جاهزية واتساب."}
          </div>

          {statusValue && (
            <div
              className={cn(
                "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold",
                statusValue === "SENT" || statusValue === "DELIVERED" || statusValue === "READ"
                  ? "border-emerald-300/50 bg-emerald-50 text-emerald-800"
                  : statusValue === "FAILED"
                    ? "border-rose-300/50 bg-rose-50 text-rose-800"
                    : "bg-muted/30",
              )}
            >
              {isSending && <Loader2 aria-hidden className="size-4 animate-spin" />}
              {STATUS_LABEL[statusValue] ?? statusValue}
              {statusValue === "FAILED" && status.data?.lastError ? `: ${status.data.lastError}` : ""}
            </div>
          )}
        </div>

        <DialogFooter className="sm:justify-between">
          {!ready?.automaticAvailable && (
            <Button
              type="button"
              variant="outline"
              onClick={() => openWhatsApp(phone || defaultPhone, fallbackMessage)}
            >
              فتح واتساب يدوياً
            </Button>
          )}
          <Button
            type="button"
            disabled={!ready?.automaticAvailable || busy || isSending || statusValue === "SENT" || statusValue === "DELIVERED" || statusValue === "READ"}
            onClick={() => sendPdf.mutate({
              kind,
              documentId,
              phone: phone || null,
              caption: caption || null,
              clientRequestId: crypto.randomUUID(),
            })}
            className="bg-emerald-600 text-white hover:bg-emerald-700"
          >
            {sendPdf.isPending || isSending
              ? <Loader2 aria-hidden className="size-4 animate-spin" />
              : <Send aria-hidden className="size-4" />}
            {statusValue === "SENT" || statusValue === "DELIVERED" || statusValue === "READ"
              ? STATUS_LABEL[statusValue]
              : "تأكيد وإرسال PDF"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
