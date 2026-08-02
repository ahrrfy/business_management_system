import { useCallback, useMemo, useState } from "react";
import { Link, useParams } from "wouter";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  Monitor,
  Search,
  Send,
} from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useBarcodeScanner } from "@/hooks/useBarcodeScanner";
import { confirm } from "@/lib/confirm";
import { errMsg, notify } from "@/lib/notify";
import { fmtInt } from "@/lib/money";
import { newClientRequestId } from "@/lib/countQueue";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

type State = RouterOutputs["count"]["state"];
type CountItem = State["items"][number];

function matchesBarcode(item: CountItem, value: string) {
  return item.units.some(
    (unit) => unit.barcode === value || unit.aliases.includes(value),
  );
}

function productLabel(item: CountItem) {
  return item.variantName
    ? `${item.productName} — ${item.variantName}`
    : item.productName;
}

/** شاشة جرد سطح المكتب للحساب المسند إليه USER فقط. */
export default function MyStocktakeWorkspace() {
  const { code: rawCode } = useParams<{ code?: string }>();
  const code = decodeURIComponent(rawCode ?? "").trim();
  const utils = trpc.useUtils();
  const state = trpc.count.state.useQuery(
    { sessionCode: code },
    { enabled: Boolean(code), retry: false, refetchInterval: 5_000 },
  );
  const submit = trpc.count.submit.useMutation();
  const finish = trpc.count.finish.useMutation();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<CountItem | null>(null);
  const [quantity, setQuantity] = useState("");

  const st = state.data;
  const items = st?.items ?? [];
  const needle = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      items.filter((item) => {
        if (!needle) return true;
        return (
          productLabel(item).toLowerCase().includes(needle) ||
          item.sku.toLowerCase().includes(needle) ||
          item.units.some(
            (u) =>
              (u.barcode ?? "").toLowerCase().includes(needle) ||
              u.aliases.some((a) => a.toLowerCase().includes(needle)),
          )
        );
      }),
    [items, needle],
  );

  const openItem = useCallback(
    (item: CountItem) => {
      if (
        st?.session.status !== "COUNTING" ||
        st.assignment.status === "SUBMITTED"
      )
        return;
      if (
        st.session.dupPolicy === "BLOCK" &&
        item.colleagueCounted &&
        !item.myCount
      ) {
        notify.info("هذا المنتج عُدّ مسبقاً، وسياسة الجلسة تمنع العدّ المكرر.");
        return;
      }
      setSelected(item);
      setQuantity(item.myCount ? String(item.myCount.qty) : "");
    },
    [st],
  );

  const onBarcode = useCallback(
    (raw: string) => {
      const value = raw.trim();
      if (!value) return;
      const found = items.find(
        (item) => matchesBarcode(item, value) || item.sku === value,
      );
      if (!found) {
        notify.warn("الباركود لا يطابق منتجاً في هذه الجلسة", value);
        return;
      }
      openItem(found);
    },
    [items, openItem],
  );
  useBarcodeScanner(onBarcode, { enabled: Boolean(st) && selected == null });

  const save = () => {
    if (!selected) return;
    const qty = Number(quantity);
    if (!Number.isSafeInteger(qty) || qty < 0) {
      notify.warn("أدخل كمية صحيحة تساوي صفراً أو أكثر.");
      return;
    }
    submit.mutate(
      {
        sessionCode: code,
        variantId: selected.variantId,
        qty,
        clientRequestId: newClientRequestId(),
      },
      {
        onSuccess: async () => {
          setSelected(null);
          notify.ok("تم حفظ العدّ");
          await utils.count.state.invalidate({ sessionCode: code });
        },
        onError: (error) => notify.err(error),
      },
    );
  };

  const submitAssignment = async () => {
    if (
      !st ||
      !(await confirm({
        title: "تسليم العدّ للمراجعة",
        description:
          "لن تتمكن من إضافة أو تعديل عدّك بعد التسليم. لا تنهِ المهمة إلا بعد توجيه المسؤول.",
        confirmText: "تسليم العدّ",
        variant: "warning",
      }))
    )
      return;
    finish.mutate(
      { sessionCode: code },
      {
        onSuccess: async (result) => {
          notify.ok(
            result.sessionMovedToReview
              ? "اكتمل الجرد وانتقل للمراجعة"
              : "تم تسليم عدّك للمراجعة",
          );
          await Promise.all([
            utils.count.state.invalidate({ sessionCode: code }),
            utils.count.mine.invalidate(),
          ]);
        },
        onError: (error) => notify.err(error),
      },
    );
  };

  if (!code)
    return <p className="p-8 text-destructive">رابط مهمة الجرد غير صالح.</p>;
  if (state.isLoading)
    return (
      <p className="p-8 text-sm text-muted-foreground">جارٍ فتح مساحة الجرد…</p>
    );
  if (state.isError || !st) {
    return (
      <Card className="mx-auto mt-10 max-w-2xl">
        <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
          <AlertTriangle className="size-10 text-stock-low" aria-hidden />
          <div>
            <p className="font-bold">لا يمكن فتح مهمة الجرد بهذا الحساب</p>
            <p className="mt-1 text-sm text-muted-foreground">
              يجب أن يكون تكليفك من نوع «حساب مستخدم داخل النظام». لا يوجد PIN
              في شاشة الحسابات.
            </p>
            <p className="mt-2 text-xs text-destructive">
              {state.error ? errMsg(state.error) : ""}
            </p>
          </div>
          <Link href="/my-stocktake">
            <Button variant="outline">العودة إلى جردي</Button>
          </Link>
        </CardContent>
      </Card>
    );
  }

  const overall = st.progress.session;
  const mine = st.progress.mine;
  const remaining = Math.max(0, overall.total - overall.counted);
  const overallPct = overall.total
    ? Math.round((overall.counted / overall.total) * 100)
    : 0;
  const canCount =
    st.session.status === "COUNTING" && st.assignment.status === "ACTIVE";

  return (
    <div className="mx-auto max-w-[1500px] space-y-5 p-1">
      <header className="flex flex-wrap items-start justify-between gap-4 rounded-2xl border bg-card p-6 shadow-sm">
        <div>
          <div className="mb-2 flex items-center gap-2 text-primary">
            <Monitor className="size-5" aria-hidden />{" "}
            <span className="text-sm font-bold">شاشة جرد الحاسوب</span>
          </div>
          <h1 className="text-2xl font-bold">{st.session.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {st.session.branchName} · مرحباً {st.assignment.name}
            {st.assignment.zone ? ` · المنطقة: ${st.assignment.zone}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2 rounded-xl bg-primary/10 px-4 py-2 text-sm font-bold text-primary">
          <ClipboardCheck className="size-4" aria-hidden /> جرد أعمى
        </div>
      </header>

      <section className="grid gap-4 lg:grid-cols-3">
        <Metric
          title="تقدّم الجلسة"
          value={`${fmtInt(overall.counted)} / ${fmtInt(overall.total)}`}
          hint={`${fmtInt(remaining)} منتج متبقٍ`}
          pct={overallPct}
        />
        <Metric
          title="عدّي المسجّل"
          value={`${fmtInt(mine.counted)} / ${fmtInt(mine.total)}`}
          hint="عدد المنتجات التي أدخلتها أنت"
          pct={mine.total ? Math.round((mine.counted / mine.total) * 100) : 0}
        />
        <Card className="gap-3 py-5">
          <CardHeader className="px-5">
            <CardTitle className="text-base">حالة المهمة</CardTitle>
            <CardDescription>
              {canCount
                ? "قيد العدّ — يمكنك الحفظ والمتابعة لاحقاً."
                : st.assignment.status === "SUBMITTED"
                  ? "تم تسليم عدّك للمراجعة."
                  : "أغلقت الجلسة للمراجعة."}
            </CardDescription>
          </CardHeader>
          <CardContent className="px-5">
            <Button
              className="w-full"
              disabled={!canCount || finish.isPending}
              onClick={() => void submitAssignment()}
            >
              <Send className="size-4" aria-hidden /> تسليم عدّي للمراجعة
            </Button>
          </CardContent>
        </Card>
      </section>

      {st.recountTasks.length > 0 && (
        <div className="badge-stock-low rounded-xl border border-border p-4 text-sm">
          <p className="font-bold">
            يوجد {fmtInt(st.recountTasks.length)} طلب إعادة عدّ.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {st.recountTasks.map((task) => (
              <Button
                key={task.variantId}
                size="sm"
                variant="outline"
                onClick={() => {
                  const item = items.find(
                    (i) => i.variantId === task.variantId,
                  );
                  if (item) openItem(item);
                }}
              >
                {task.productName} — إعادة عدّ
              </Button>
            ))}
          </div>
        </div>
      )}

      <Card className="gap-0 overflow-hidden">
        <CardHeader className="border-b">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>المنتجات</CardTitle>
              <CardDescription>
                امسح الباركود بقارئ الحاسوب أو ابحث ثم أدخل الكمية الفعلية.
              </CardDescription>
            </div>
            <div className="relative w-full sm:w-96">
              <Search
                className="absolute right-3 top-3 size-4 text-muted-foreground"
                aria-hidden
              />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="اسم المنتج أو SKU أو باركود…"
                className="pr-9"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="grid grid-cols-[minmax(280px,1fr)_130px_120px] border-b bg-muted/40 px-5 py-3 text-xs font-bold text-muted-foreground">
            <span>المنتج</span>
            <span>حالة الجلسة</span>
            <span>إجرائي</span>
          </div>
          <div className="max-h-[52vh] overflow-y-auto">
            {filtered.map((item) => (
              <button
                key={item.variantId}
                type="button"
                onClick={() => openItem(item)}
                disabled={!canCount}
                className="grid w-full grid-cols-[minmax(280px,1fr)_130px_120px] items-center border-b px-5 py-3 text-right transition hover:bg-muted/50 disabled:cursor-default"
              >
                <span className="min-w-0">
                  <span className="block truncate font-bold">
                    {productLabel(item)}
                  </span>
                  <span
                    className="mt-0.5 block truncate font-mono text-xs text-muted-foreground"
                    dir="ltr"
                  >
                    {item.sku ||
                      item.units.find((u) => u.barcode)?.barcode ||
                      "—"}
                  </span>
                </span>
                <span>
                  {item.counted ? (
                    <span className="inline-flex items-center gap-1 text-stock-ok">
                      <CheckCircle2 className="size-4" aria-hidden /> معدود
                    </span>
                  ) : (
                    <span className="text-muted-foreground">غير معدود</span>
                  )}
                </span>
                <span>
                  {item.myCount ? (
                    <span className="font-mono text-primary" dir="ltr">
                      {fmtInt(item.myCount.qty)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </span>
              </button>
            ))}
            {filtered.length === 0 && (
              <p className="p-10 text-center text-sm text-muted-foreground">
                لا توجد نتائج مطابقة.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <Dialog
        open={selected != null}
        onOpenChange={(open) => {
          if (!open && !submit.isPending) setSelected(null);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{selected ? productLabel(selected) : ""}</DialogTitle>
          </DialogHeader>
          {selected && (
            <div className="space-y-4">
              {selected.colleagueCounted && !selected.myCount && (
                <p className="rounded-lg bg-primary/10 p-3 text-xs text-primary">
                  عدّ تحققي: المنتج عُدّ من زميل، لكن كميته لا تظهر لك حفاظاً
                  على الجرد الأعمى.
                </p>
              )}
              <div className="rounded-lg border bg-muted/30 p-3 text-sm">
                <p
                  className="font-mono text-xs text-muted-foreground"
                  dir="ltr"
                >
                  {selected.sku || "—"}
                </p>
                <p className="mt-2 text-muted-foreground">
                  أدخل الكمية الفعلية بالوحدة الأساسية.{" "}
                  {selected.units.find((u) => u.factor === 1)?.unitName ??
                    "قطعة"}
                </p>
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-bold">
                  الكمية المعدودة
                </label>
                <Input
                  autoFocus
                  inputMode="numeric"
                  dir="ltr"
                  value={quantity}
                  onChange={(e) =>
                    setQuantity(e.target.value.replace(/\D/g, "").slice(0, 8))
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") save();
                  }}
                  placeholder="0"
                  className="h-12 text-center font-mono text-xl"
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={submit.isPending}
              onClick={() => setSelected(null)}
            >
              إلغاء
            </Button>
            <Button
              disabled={submit.isPending || quantity === ""}
              onClick={save}
            >
              {submit.isPending ? "جارٍ الحفظ…" : "حفظ العدّ"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Metric({
  title,
  value,
  hint,
  pct,
}: {
  title: string;
  value: string;
  hint: string;
  pct: number;
}) {
  return (
    <Card className="gap-3 py-5">
      <CardHeader className="px-5">
        <CardTitle className="text-base">{title}</CardTitle>
        <div className="text-2xl font-bold tabular-nums" dir="ltr">
          {value}
        </div>
        <CardDescription>{hint}</CardDescription>
      </CardHeader>
      <CardContent className="px-5">
        <div className="h-2 overflow-hidden rounded-full bg-primary/10">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
          />
        </div>
      </CardContent>
    </Card>
  );
}
