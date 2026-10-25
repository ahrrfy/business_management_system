import { useState } from "react";
import { CheckCircle2 } from "lucide-react";
import type { OfflineOutboxItem } from "@/lib/offline/db";
import {
  replayParkedWithApproval,
  requeueParkedItem,
} from "@/lib/offline/outbox";
import { offlineOutboxStatusLabel } from "@shared/offlineOutboxTerms";
import { fmt } from "@/lib/money";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import type { OfflineApprovalApiFactory } from "./offlineReplayApi";

export function OfflineOutboxRow({
  item,
  offline,
  pending,
  error,
  run,
  approvalApi,
  flushNow,
  refresh,
}: {
  item: OfflineOutboxItem;
  offline: boolean;
  pending: boolean;
  error: string | null;
  run: (task: () => Promise<void>) => Promise<void>;
  approvalApi: OfflineApprovalApiFactory;
  flushNow: (force?: boolean) => Promise<void>;
  refresh: () => void;
}) {
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                void run(async () => {
                  await requeueParkedItem(item.clientRequestId);
                  await flushNow(true);
                })
              }
              className="rounded border px-2 py-1 text-[11px] font-semibold disabled:opacity-50"
            >
              إعادة المحاولة
            </button>
            {item.kind !== "RETURN" ? (
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  setApprovalOpen((value) => !value);
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
          </div>
          {approvalOpen && item.kind !== "RETURN" ? (
            <div className="space-y-2 rounded-md border bg-muted/40 p-2">
              <p className="text-[11px] text-muted-foreground">
                لترحيل بيع رفضه الخادم؛ تتحقق هوية المدير خادمياً ويسجل
                الاعتماد.
              </p>
              <Input
                type="email"
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
                {pending ? "قيد الترحيل…" : "اعتماد وترحيل"}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
