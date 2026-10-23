import type { RouterInputs } from "@/lib/trpc";
import { Link } from "wouter";
import { Check, Palette, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { isWebUsbSupported } from "@/lib/printing/print";
export interface ReceptionOpenShiftInput {
  branchId: number;
  opening: string;
  setOpening: React.Dispatch<React.SetStateAction<string>>;
  bridge: { enabled: boolean; description: string };
  connectPrinter: () => Promise<void>;
  printerReady: boolean;
  canAction: (path: string) => boolean;
  openShiftM: {
    isPending: boolean;
    mutate: (input: RouterInputs["shifts"]["open"]) => void;
  };
  canActionRef: React.RefObject<(path: string) => boolean>;
}
export function ReceptionOpenShift({
  branchId,
  opening,
  setOpening,
  bridge,
  connectPrinter,
  printerReady,
  canAction,
  openShiftM,
  canActionRef,
}: ReceptionOpenShiftInput) {
  return (
    <div
      className="flex h-full items-center justify-center bg-background p-4"
      dir="rtl"
    >
      <div className="w-full max-w-md rounded-2xl border bg-card p-7 shadow-lg">
        <div className="mb-1 flex items-center gap-2">
          <span className="grid size-9 place-items-center rounded-lg bg-violet-100 text-violet-700">
            <Palette aria-hidden className="size-5" />
          </span>
          <h2 className="text-xl font-extrabold">ابدأ الوردية</h2>
        </div>
        <p className="mb-5 text-sm text-muted-foreground">
          أدخل المبلغ الموجود في درج النقدية، ثم ابدأ استقبال العملاء والطلبات.
        </p>
        <label className="mb-1.5 block text-sm font-bold">
          المبلغ الموجود في الدرج الآن (د.ع)
        </label>
        <Input
          dir="ltr"
          inputMode="decimal"
          value={opening}
          onChange={(e) => setOpening(e.target.value)}
          className="mb-3 h-12 text-end text-lg font-extrabold tabular-nums"
        />
        {/* اربط الطابعة الحرارية هنا **قبل** فتح الوردية كي يُطبَع إيصال الافتتاح صامتاً فوراً
              بدل نافذة طباعة المتصفّح (كانت لا تظهر إلا بعد فتح الوردية داخل رأس الشاشة الرئيسية). */}
        {isWebUsbSupported() && !bridge.enabled && (
          <button
            type="button"
            onClick={() => void connectPrinter()}
            title={
              printerReady
                ? "الطابعة الحرارية مربوطة — اضغط لتبديلها"
                : "اربط طابعة حرارية كي يُطبع إيصال فتح الوردية عليها مباشرة"
            }
            className={cn(
              "mb-3 flex h-10 w-full items-center justify-center gap-1.5 rounded-lg border text-xs font-bold transition-colors hover:bg-muted/60",
              printerReady
                ? "border-[var(--money-positive)] text-money-positive"
                : "text-muted-foreground",
            )}
          >
            <Printer aria-hidden className="size-3.5" />
            {printerReady ? (
              <>
                الطابعة الحرارية مربوطة{" "}
                <Check aria-hidden className="size-3.5" strokeWidth={3} />
              </>
            ) : (
              "اربط الطابعة الحرارية لطباعة إيصال الوردية"
            )}
          </button>
        )}
        <Button
          className="h-12 w-full text-base font-bold"
          disabled={!canAction("shifts.open") || openShiftM.isPending}
          onClick={() =>
            canActionRef.current("shifts.open") &&
            openShiftM.mutate({
              branchId,
              openingBalance: opening || "0",
              shiftType: "RECEPTION",
            })
          }
        >
          {openShiftM.isPending ? "جارٍ البدء…" : "بدء الوردية"}
        </Button>
        <Link
          href="/"
          className="mt-3 block text-center text-sm text-muted-foreground"
        >
          ← الرئيسية
        </Link>
      </div>
    </div>
  );
}
