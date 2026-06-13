import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { confirm } from "@/lib/confirm";
import { fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { Link, useRoute } from "wouter";

function fmtDateTime(d: Date | string) {
  try { return new Date(d).toLocaleString("ar-IQ-u-nu-latn", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); }
  catch { return String(d); }
}

export default function ProductionDetail() {
  const [, params] = useRoute("/production/:id");
  const id = Number(params?.id);
  const me = trpc.auth.me.useQuery();
  const isManager = me.data?.role === "admin" || me.data?.role === "manager";
  const utils = trpc.useUtils();

  const q = trpc.production.get.useQuery({ productionOrderId: id }, { enabled: Number.isFinite(id) && id > 0 });
  const doc = q.data as any;

  const cancel = trpc.production.cancel.useMutation({
    onSuccess: () => {
      notify.ok("أُلغي المستند", "عاد المخزون وسُحبت المخرجات.");
      utils.production.get.invalidate({ productionOrderId: id });
      utils.production.list.invalidate();
      utils.inventory.onHand.invalidate();
      utils.inventory.movementsRich.invalidate();
    },
    onError: (e) => notify.err(e),
  });

  async function onCancel() {
    const ok = await confirm({
      variant: "danger",
      title: "إلغاء مستند الإنتاج",
      description: "ستُعاد المدخلات للمخزون وتُسحب المخرجات. متابعة؟",
      confirmText: "إلغاء المستند",
    });
    if (!ok) return;
    cancel.mutate({ productionOrderId: id });
  }

  if (q.isLoading) return <div className="p-6 text-muted-foreground" dir="rtl">جارٍ التحميل…</div>;
  if (!doc) return <div className="p-6 text-muted-foreground" dir="rtl">المستند غير موجود.</div>;

  const inputs = doc.inputs ?? [];
  const outputs = doc.outputs ?? [];

  return (
    <div className="space-y-4 max-w-4xl" dir="rtl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">مستند إنتاج <span className="font-mono text-lg" dir="ltr">{doc.docNumber}</span></h1>
        <Link href="/production" className="text-sm text-muted-foreground">← رجوع</Link>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">الرأس</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <div><div className="text-xs text-muted-foreground">الفرع</div><div>{doc.branchName}</div></div>
          <div><div className="text-xs text-muted-foreground">الحالة</div>
            <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${doc.status === "CANCELLED" ? "bg-muted text-muted-foreground" : "bg-emerald-100 text-emerald-700"}`}>
              {doc.status === "CANCELLED" ? "ملغى" : "مُرحَّل"}
            </span>
          </div>
          <div><div className="text-xs text-muted-foreground">كلفة المواد</div><div className="tabular-nums" dir="ltr">{fmt(doc.materialsCost)}</div></div>
          <div><div className="text-xs text-muted-foreground">العمالة</div><div className="tabular-nums" dir="ltr">{fmt(doc.laborCost)}</div></div>
          <div><div className="text-xs text-muted-foreground">الكلفة الكلية</div><div className="font-bold text-sky-700 tabular-nums" dir="ltr">{fmt(doc.totalCost)}</div></div>
          <div><div className="text-xs text-muted-foreground">التاريخ</div><div className="text-xs">{fmtDateTime(doc.createdAt)}</div></div>
          {doc.linkedRecipeId && <div><div className="text-xs text-muted-foreground">وصفة</div><div>#{doc.linkedRecipeId}</div></div>}
          {doc.notes && <div className="col-span-2"><div className="text-xs text-muted-foreground">ملاحظة</div><div>{doc.notes}</div></div>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">المدخلات (المُستهلَكة)</CardTitle></CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50"><tr className="text-right">
              <th className="p-2">المادة</th><th className="p-2">SKU</th><th className="p-2 text-center">الكمية (أساس)</th><th className="p-2 text-left">كلفة الوحدة</th><th className="p-2 text-left">كلفة السطر</th>
            </tr></thead>
            <tbody>
              {inputs.map((l: any) => (
                <tr key={Number(l.id)} className="border-t">
                  <td className="p-2">{l.productName}{l.variantName ? ` — ${l.variantName}` : ""}</td>
                  <td className="p-2 font-mono text-xs" dir="ltr">{l.sku}</td>
                  <td className="p-2 text-center tabular-nums" dir="ltr">{Number(l.baseQuantity).toLocaleString("en-US")}</td>
                  <td className="p-2 text-left tabular-nums" dir="ltr">{fmt(l.unitCost)}</td>
                  <td className="p-2 text-left tabular-nums" dir="ltr">{fmt(l.lineCost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">المخرجات (المُنتَجة)</CardTitle></CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50"><tr className="text-right">
              <th className="p-2">المنتَج</th><th className="p-2">SKU</th><th className="p-2 text-center">الكمية (أساس)</th><th className="p-2 text-left">كلفة الوحدة المحتسبة</th><th className="p-2 text-left">الكلفة المُمتصّة</th>
            </tr></thead>
            <tbody>
              {outputs.map((l: any) => (
                <tr key={Number(l.id)} className="border-t">
                  <td className="p-2">{l.productName}{l.variantName ? ` — ${l.variantName}` : ""}</td>
                  <td className="p-2 font-mono text-xs" dir="ltr">{l.sku}</td>
                  <td className="p-2 text-center tabular-nums" dir="ltr">{Number(l.baseQuantity).toLocaleString("en-US")}</td>
                  <td className="p-2 text-left tabular-nums text-sky-700" dir="ltr">{fmt(l.unitCost)}</td>
                  <td className="p-2 text-left tabular-nums" dir="ltr">{fmt(l.allocatedCost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {isManager && doc.status !== "CANCELLED" && (
        <div>
          <Button variant="destructive" onClick={onCancel} disabled={cancel.isPending}>
            {cancel.isPending ? "جارٍ الإلغاء…" : "إلغاء المستند (يعكس المخزون)"}
          </Button>
        </div>
      )}
    </div>
  );
}
