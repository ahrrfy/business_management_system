import { useState } from "react";
import { CheckCircle2 } from "lucide-react";
import type { OfflineOutboxItem } from "@/lib/offline/db";
import {
  dismissParkedOutboxItemClient,
  isFencedParkedError,
  markOutboxItemSent,
  reissueParkedSaleItem,
  removeResolvedOutboxItem,
  replayParkedWithApproval,
  requeueParkedItem,
} from "@/lib/offline/outbox";
import { offlineOutboxStatusLabel } from "@shared/offlineOutboxTerms";
import { fmt } from "@/lib/money";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import type {
  OfflineApprovalApiFactory,
  OfflineParkedResolutionActions,
} from "./offlineReplayApi";

export function OfflineOutboxRow({
  item,
  offline,
  elevated = false,
  pending,
  error,
  run,
  approvalApi,
  resolutionActions,
  onStatusNotice,
  flushNow,
  refresh,
}: {
  item: OfflineOutboxItem;
  offline: boolean;
  elevated?: boolean;
  pending: boolean;
  error: string | null;
  run: (task: () => Promise<void>) => Promise<void>;
  approvalApi: OfflineApprovalApiFactory;
  resolutionActions?: OfflineParkedResolutionActions;
  onStatusNotice?: (msg: string | null) => void;
  flushNow: (force?: boolean) => Promise<void>;
  refresh: () => void;
}) {
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [dismissOpen, setDismissOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [dismissReason, setDismissReason] = useState("");
  const [probedFenced, setProbedFenced] = useState(false);
  const isFenced = probedFenced || isFencedParkedError(error ?? item.lastError);
  const canReissueSale =
    isFenced &&
    (item.kind ?? "SALE") === "SALE" &&
    Boolean(resolutionActions?.reissueFencedSale);
  const canDismiss = Boolean(resolutionActions?.dismissParkedItem);

  const handleRetryOrProbe = async () => {
    onStatusNotice?.(null);
    if (resolutionActions?.probeStatus && !offline) {
      const probe = await resolutionActions.probeStatus(item);
      if (probe.outcome === "COMMITTED") {
        await markOutboxItemSent(item.clientRequestId, probe.invoiceNumber);
        refresh();
        onStatusNotice?.(
          probe.invoiceNumber
            ? `تأكد الترحيل مسبقاً على الخادم بفاتورة ${probe.invoiceNumber}`
            : "تأكد الترحيل مسبقاً على الخادم",
        );
        return;
      }
      if (probe.recoveryStatus === "DISCARDED") {
        await removeResolvedOutboxItem(item.clientRequestId);
        refresh();
        onStatusNotice?.(
          probe.discardReason
            ? `أهمل العنصر مسبقاً في طابور الاسترداد (${probe.discardReason}) وتم إغلاقه من الطابور`
            : "أهمل العنصر مسبقاً في طابور الاسترداد وتم إغلاقه من الطابور",
        );
        return;
      }
      if (probe.outcome === "FENCED_NOT_COMMITTED") {
        setProbedFenced(true);
        throw new Error(
          "المعرف مسيج خادمياً قبل الالتزام ولا يقبل إعادة المحاولة بنفسه — استخدم «ترحيل بمعرف بديل» أو «إسقاط وإنهاء» أدناه",
        );
      }
    }
    if (isFencedParkedError(item.lastError)) {
      setProbedFenced(true);
      throw new Error(
        "المعرف مسيج خادمياً قبل الالتزام ولا يقبل إعادة المحاولة بنفسه — استخدم «ترحيل بمعرف بديل» أو «إسقاط وإنهاء» أدناه",
      );
    }
    await requeueParkedItem(item.clientRequestId);
    await flushNow(true);
  };

  const handleReissue = async (approval?: { email: string; password: string }) => {
    if (!resolutionActions?.reissueFencedSale) {
      throw new Error("مسار إعادة الترحيل بمعرف بديل غير متاح");
    }
    onStatusNotice?.(null);
    const result = await reissueParkedSaleItem(item.clientRequestId, (args) =>
      resolutionActions.reissueFencedSale!(args, approval),
    );
    refresh();
    if (!result.ok) {
      throw new Error(result.error ?? "تعذر إعادة ترحيل العملية بمعرف بديل");
    }
    setApprovalOpen(false);
    setEmail("");
    setPassword("");
    onStatusNotice?.(
      result.outcome === "CAPTURED_IN_RECOVERY"
        ? "نقلت العملية بأمان إلى طابور الاسترداد في تقرير المبيعات الأوفلاين لترحيلها إلى وردية مفتوحة"
        : (result.message ??
          (result.invoiceNumber
            ? `تم الترحيل بنجاح — فاتورة ${result.invoiceNumber}`
            : "تم الترحيل بنجاح")),
    );
  };

  const handleDismiss = async () => {
    if (!resolutionActions?.dismissParkedItem) {
      throw new Error("مسار إنهاء وإسقاط العنصر غير متاح");
    }
    const reason = dismissReason.trim();
    if (reason.length < 5) {
      throw new Error("يرجى كتابة سبب الإنهاء أو الإسقاط (٥ أحرف على الأقل)");
    }
    onStatusNotice?.(null);
    const approval =
      !elevated && email.trim() && password
        ? { email: email.trim(), password }
        : undefined;
    const result = await dismissParkedOutboxItemClient(
      item.clientRequestId,
      (args) =>
        resolutionActions.dismissParkedItem!({
          ...args,
          reason,
          ...(approval ? { managerApproval: approval } : {}),
        }),
    );
    refresh();
    if (!result.ok) {
      throw new Error(result.error ?? "تعذر إنهاء وإسقاط العملية من الطابور");
    }
    setDismissOpen(false);
    setApprovalOpen(false);
    setDismissReason("");
    setEmail("");
    setPassword("");
    onStatusNotice?.(
      result.outcome === "ALREADY_COMMITTED"
        ? `تأكد ترحيل الفاتورة مسبقاً (${result.invoiceNumber ?? "—"})`
        : (result.message ?? "تم إنهاء وإسقاط العملية من الطابور وتسجيل القرار خادمياً"),
    );
  };

  return (
    <div className="min-w-0 border-b px-3 py-2 text-xs last:border-b-0 [overflow-wrap:anywhere]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 break-all font-mono font-semibold" dir="ltr">
          {item.offlineReceiptNumber}
        </span>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[10px] font-bold",
            item.status === "SENT" &&
              "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]",
            item.status === "PARKED" &&
              "bg-[var(--sem-neg-bg)] text-[var(--sem-neg)]",
            (item.status === "QUEUED" || item.status === "SENDING") &&
              "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]",
          )}
        >
          {offlineOutboxStatusLabel(item.status)}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-muted-foreground">
        <span dir="ltr">{fmt(item.total)} د.ع</span>
        {item.status === "SENT" && item.resultInvoiceNumber ? (
          <span className="flex min-w-0 items-center gap-1 font-mono" dir="ltr">
            <CheckCircle2
              aria-hidden
              className="size-3 shrink-0 text-[var(--sem-pos)]"
            />
            <span className="break-all">{item.resultInvoiceNumber}</span>
          </span>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-destructive">
          {error}
        </p>
      ) : null}
      {item.status === "PARKED" ? (
        <div className="mt-1 space-y-2">
          {item.lastError && !error ? (
            <p className="text-destructive">{item.lastError}</p>
          ) : null}
          {(error ?? item.lastError ?? "").includes("تصنيف استخدام") ? (
            <p className="rounded border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] px-2 py-1 text-[11px] text-[var(--sem-warn)]">
              تعارض مع تصنيف استخدام الصنف المحدث بعد التقاط العملية دون اتصال — حفظ الطلب في طابور الاسترداد الخادمي لمراجعة المدير أو تحديث تصنيف الصنف ثم إعادة المحاولة.
            </p>
          ) : null}
          {isFenced ? (
            <p className="rounded border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] px-2 py-1 text-[11px] text-[var(--sem-warn)]">
              أُلغي هذا المعرف على الخادم قبل الالتزام ولن يقبل بنفس المعرف. اختر «ترحيل بمعرف بديل» إذا تم البيع فعلاً، أو «إسقاط وإنهاء» لإغلاق العنصر من الطابور بأثر تدقيقي.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() => void run(handleRetryOrProbe)}
              className="rounded border px-2 py-1 text-[11px] font-semibold disabled:opacity-50"
            >
              إعادة المحاولة
            </button>
            {canReissueSale && elevated ? (
              <button
                type="button"
                disabled={pending || offline}
                onClick={() => void run(() => handleReissue())}
                className="rounded border bg-primary px-2 py-1 text-[11px] font-bold text-primary-foreground disabled:opacity-50"
              >
                ترحيل بمعرف بديل
              </button>
            ) : null}
            {item.kind !== "RETURN" ? (
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  setApprovalOpen((value) => !value);
                  setDismissOpen(false);
                  setEmail("");
                  setPassword("");
                }}
                className="rounded border px-2 py-1 text-[11px] font-semibold disabled:opacity-50"
              >
                اعتماد مدير
              </button>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                إعادة محاولة المرتجع تتطلب صلاحية المالك في الجلسة الحالية.
              </p>
            )}
            {canDismiss ? (
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  setDismissOpen((value) => !value);
                  setApprovalOpen(false);
                  setEmail("");
                  setPassword("");
                }}
                className="rounded border px-2 py-1 text-[11px] font-semibold text-destructive disabled:opacity-50"
              >
                إسقاط وإنهاء
              </button>
            ) : null}
          </div>
          {approvalOpen && item.kind !== "RETURN" ? (
            <div className="space-y-2 rounded-md border bg-muted/40 p-2">
              <p className="text-[11px] text-muted-foreground">
                {canReissueSale
                  ? "لإعادة ترحيل العملية بمعرف بديل (أو نقلها لطابور الاسترداد إن أغلقت الوردية): تتحقق هوية المدير خادمياً ويسجل الاعتماد."
                  : "لترحيل بيع رفضه الخادم؛ تتحقق هوية المدير خادمياً ويسجل الاعتماد."}
              </p>
              <Input
                type="text"
                dir="ltr"
                aria-label="بريد المدير"
                placeholder="بريد المدير"
                value={email}
                disabled={pending}
                onChange={(event) => setEmail(event.target.value)}
              />
              <Input
                type="password"
                dir="ltr"
                aria-label="كلمة مرور المدير"
                placeholder="كلمة المرور"
                autoComplete="off"
                value={password}
                disabled={pending}
                onChange={(event) => setPassword(event.target.value)}
              />
              <button
                type="button"
                disabled={!email.trim() || !password || pending || offline}
                onClick={() =>
                  void run(async () => {
                    if (canReissueSale) {
                      await handleReissue({ email: email.trim(), password });
                      return;
                    }
                    const result = await replayParkedWithApproval(
                      item.clientRequestId,
                      approvalApi({ email: email.trim(), password }),
                    );
                    refresh();
                    if (!result.ok)
                      throw new Error(
                        result.error ?? "تعذر اعتماد وترحيل العملية",
                      );
                    setApprovalOpen(false);
                    setEmail("");
                    setPassword("");
                  })
                }
                className="w-full rounded bg-primary px-2 py-2 text-[11px] font-bold text-primary-foreground disabled:opacity-50"
              >
                {pending
                  ? "قيد الترحيل…"
                  : canReissueSale
                    ? "اعتماد وترحيل بمعرف بديل"
                    : "اعتماد وترحيل"}
              </button>
            </div>
          ) : null}
          {dismissOpen && canDismiss ? (
            <div className="space-y-2 rounded-md border border-destructive/40 bg-muted/40 p-2">
              <p className="text-[11px] text-muted-foreground">
                يُنهي العملية من الطابور المحلي نهائياً مع تسجيل القرار في سجل التدقيق الخادمي (بعد التأكد من عدم وجود فاتورة ملتزمة لها).
              </p>
              <Input
                type="text"
                aria-label="سبب الإسقاط والإنهاء"
                placeholder="سبب الإنهاء أو الإسقاط (٥ أحرف على الأقل)"
                value={dismissReason}
                disabled={pending}
                onChange={(event) => setDismissReason(event.target.value)}
              />
              {!elevated ? (
                <>
                  <Input
                    type="text"
                    dir="ltr"
                    aria-label="بريد أو اسم مستخدم المدير للإسقاط"
                    placeholder="بريد أو اسم مستخدم المدير"
                    value={email}
                    disabled={pending}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                  <Input
                    type="password"
                    dir="ltr"
                    aria-label="كلمة مرور المدير للإسقاط"
                    placeholder="كلمة المرور"
                    autoComplete="off"
                    value={password}
                    disabled={pending}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </>
              ) : null}
              <button
                type="button"
                disabled={
                  dismissReason.trim().length < 5 ||
                  (!elevated && (!email.trim() || !password)) ||
                  pending ||
                  offline
                }
                onClick={() => void run(handleDismiss)}
                className="w-full rounded bg-destructive px-2 py-2 text-[11px] font-bold text-destructive-foreground disabled:opacity-50"
              >
                {pending ? "قيد الإنهاء…" : "تأكيد الإسقاط والإنهاء"}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
