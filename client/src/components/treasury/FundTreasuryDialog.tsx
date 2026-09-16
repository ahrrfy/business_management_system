import { useEffect, useState } from "react";
import { Vault } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AppSelect } from "@/components/ui/AppSelect";
import { MoneyInput } from "@/components/form/MoneyInput";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { fmtAr } from "@/lib/money";
import { newClientRequestId } from "@/lib/countQueue";

const selectCls =
  "h-8 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export interface FundTreasuryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultBranchId?: number | "";
  isAdmin: boolean;
  branches: Array<{ id: number; name: string }>;
  onSuccess: () => void;
}

export function FundTreasuryDialog({
  open,
  onOpenChange,
  defaultBranchId = "",
  isAdmin,
  branches,
  onSuccess,
}: FundTreasuryDialogProps) {
  const [branch, setBranch] = useState<number | "">(defaultBranchId);
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [notes, setNotes] = useState("");
  const [requestId, setRequestId] = useState("");

  useEffect(() => {
    if (open) {
      setRequestId(newClientRequestId());
      setBranch(defaultBranchId);
      setAmount("");
      setDescription("");
      setNotes("");
    }
  }, [open, defaultBranchId]);

  const fundTreasuryM = trpc.treasury.fundTreasury.useMutation({
    onSuccess: (r) => {
      notify.ok(
        "تم تمويل الخزينة",
        `السند ${r.referenceNumber} — الرصيد بعده ${fmtAr(r.treasuryBalanceAfter)} د.ع`,
      );
      onOpenChange(false);
      onSuccess();
    },
    onError: (e) => notify.err(e),
  });

  const amountValid =
    /^\d+(\.\d{1,2})?$/.test(amount) && Number(amount) > 0;

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      dir="rtl"
      onClick={() => onOpenChange(false)}
    >
      <div
        className="w-full max-w-md rounded-lg border bg-card p-5 shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-label="تمويل الخزينة"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center gap-2">
          <Vault className="h-5 w-5 text-primary" />
          <h2 className="text-base font-bold">تمويل الخزينة</h2>
        </div>
        <p className="mb-4 text-xs text-muted-foreground">
          إيداع رأس مال / رصيد افتتاحيّ في خزينة الفرع — يُموّل عهد
          الورديات. يُسجَّل بسند وقيدٍ للتدقيق.
        </p>
        <div className="grid gap-3">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              الفرع
            </label>
            {isAdmin ? (
              <AppSelect
                className={selectCls + " w-full"}
                value={String(branch)}
                onValueChange={(value) =>
                  setBranch(value ? Number(value) : "")
                }
              >
                <option value="">— اختر الفرع —</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </AppSelect>
            ) : (
              <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
                {branches.find(
                  (b) => Number(b.id) === Number(branch),
                )?.name ?? (branch ? `فرع #${branch}` : "—")}
              </div>
            )}
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              المبلغ (د.ع)
            </label>
            <MoneyInput
              value={amount}
              onChange={setAmount}
              placeholder="0"
              className={selectCls + " w-full text-right font-bold"}
              ariaLabel="مبلغ تمويل الخزينة"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              التبرير / المصدر (إلزامي)
            </label>
            <input
              value={description}
              maxLength={500}
              placeholder="مثال: إيداع رأس مال أوّليّ من المالك"
              onChange={(e) => setDescription(e.target.value)}
              className={selectCls + " w-full"}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              ملاحظة (اختياري)
            </label>
            <input
              value={notes}
              maxLength={500}
              onChange={(e) => setNotes(e.target.value)}
              className={selectCls + " w-full"}
            />
          </div>
        </div>
        <div className="mt-5 flex gap-2">
          <Button
            variant="outline"
            className="flex-1"
            onClick={() => onOpenChange(false)}
          >
            إلغاء
          </Button>
          <Button
            className="flex-1"
            disabled={
              fundTreasuryM.isPending ||
              !branch ||
              !amountValid ||
              !description.trim()
            }
            onClick={() =>
              fundTreasuryM.mutate({
                branchId: Number(branch),
                amount,
                description: description.trim(),
                notes: notes.trim() || null,
                clientRequestId: requestId,
              })
            }
          >
            {fundTreasuryM.isPending ? "جارٍ التمويل…" : "تمويل الخزينة"}
          </Button>
        </div>
      </div>
    </div>
  );
}
