// تبويب «الصيرفات» — قائمة الصرّافين بأرصدتهم (دينار/دولار) + إضافة/تعديل/تعطيل.
import { useMemo, useState } from "react";
import { type ColumnDef } from "@tanstack/react-table";
import { Building2, Plus, Pencil, Power, DollarSign } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { DataTable } from "@/components/DataTable";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { D, fmtAr } from "@/lib/money";
import { BalanceTag, type ExchangeRow } from "@/components/exchange/shared";

export default function ExchangeAccounts() {
  const utils = trpc.useUtils();
  const list = trpc.exchange.list.useQuery({ limit: 200, offset: 0 });
  const [editing, setEditing] = useState<ExchangeRow | null>(null);
  const [creating, setCreating] = useState(false);

  const setActive = trpc.exchange.setActive.useMutation({
    onSuccess: () => {
      notify.ok("تم تحديث حالة الصيرفة");
      void utils.exchange.list.invalidate();
    },
    onError: (e) => notify.err(e.message),
  });

  const rows = (list.data ?? []) as ExchangeRow[];
  const totals = useMemo(() => {
    let iqd = D(0);
    let usd = D(0);
    for (const r of rows) {
      iqd = iqd.plus(D(r.balanceIqd));
      usd = usd.plus(D(r.balanceUsd));
    }
    return { count: rows.length, iqd: iqd.toFixed(2), usd: usd.toFixed(2) };
  }, [rows]);

  const cols: ColumnDef<ExchangeRow>[] = useMemo(
    () => [
      { header: "الصيرفة", accessorKey: "name" },
      {
        header: "الهاتف",
        accessorKey: "phone",
        cell: ({ row }) => <span dir="ltr" className="text-xs text-muted-foreground">{row.original.phone || "—"}</span>,
      },
      {
        header: "رصيد الدينار",
        accessorKey: "balanceIqd",
        cell: ({ row }) => <BalanceTag value={row.original.balanceIqd} unit="د.ع" />,
      },
      {
        header: "رصيد الدولار",
        accessorKey: "balanceUsd",
        cell: ({ row }) => <BalanceTag value={row.original.balanceUsd} unit="$" />,
      },
      {
        header: "متوسط كلفة الدولار",
        accessorKey: "usdCostRate",
        cell: ({ row }) => (
          <span dir="ltr" className="tabular-nums text-xs">
            {D(row.original.usdCostRate).isZero() ? "—" : fmtAr(row.original.usdCostRate)}
          </span>
        ),
      },
      {
        header: "الحالة",
        accessorKey: "isActive",
        cell: ({ row }) => (
          <span className={`text-[11px] rounded-full px-2 py-0.5 ${row.original.isActive ? "badge-status-active" : "badge-stock-out"}`}>
            {row.original.isActive ? "فعّالة" : "معطَّلة"}
          </span>
        ),
      },
      {
        header: "إجراء",
        id: "actions",
        cell: ({ row }) => (
          <div className="flex gap-1">
            <Button size="sm" variant="outline" className="h-7 gap-1" onClick={() => setEditing(row.original)}>
              <Pencil className="h-3 w-3" />
              تعديل
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1"
              onClick={() => setActive.mutate({ id: row.original.id, isActive: !row.original.isActive })}
              disabled={setActive.isPending}
            >
              <Power className="h-3 w-3" />
              {row.original.isActive ? "تعطيل" : "تفعيل"}
            </Button>
          </div>
        ),
      },
    ],
    [setActive],
  );

  return (
    <div className="space-y-4" dir="rtl">
      <PageHeader
        icon={<Building2 className="h-5 w-5 text-primary" />}
        title="الصيرفات (الصرّافون)"
        description="إدارة الصرّافين ومكاتب التحويل وأرصدتنا لديهم (دينار ودولار)."
        actions={
          <Button size="sm" onClick={() => setCreating(true)} className="gap-1.5">
            <Plus className="h-4 w-4" />
            صيرفة جديدة
          </Button>
        }
      />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard label="عدد الصيرفات" value={totals.count} icon={Building2} />
        <StatCard label="صافي أرصدتنا (دينار)" value={fmtAr(totals.iqd)} sub="موجب = لنا عندهم" tone={D(totals.iqd).isNegative() ? "negative" : "positive"} />
        <StatCard label="صافي أرصدتنا (دولار)" value={fmtAr(totals.usd)} sub="$" icon={DollarSign} tone={D(totals.usd).isNegative() ? "negative" : "positive"} />
      </div>

      <Card className="p-4">
        <div className="overflow-x-auto">
          <DataTable
            data={rows}
            columns={cols}
            loading={list.isLoading}
            emptyText="لا صيرفات بعد — أضف صيرفة جديدة."
            showFilter={true}
            pageSize={20}
          />
        </div>
      </Card>

      {(creating || editing) && (
        <ExchangeFormDialog
          editing={editing}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSuccess={() => { setCreating(false); setEditing(null); void utils.exchange.list.invalidate(); }}
        />
      )}
    </div>
  );
}

function ExchangeFormDialog({
  editing,
  onClose,
  onSuccess,
}: {
  editing: ExchangeRow | null;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const isEdit = !!editing;
  const [name, setName] = useState(editing?.name ?? "");
  const [phone, setPhone] = useState(editing?.phone ?? "");
  const [legacyCode, setLegacyCode] = useState(editing?.legacyCode ?? "");
  const [notes, setNotes] = useState(editing?.notes ?? "");
  // الرصيد الافتتاحي (إنشاء فقط).
  const [openIqd, setOpenIqd] = useState("");
  const [openUsd, setOpenUsd] = useState("");
  const [openRate, setOpenRate] = useState("");

  const create = trpc.exchange.create.useMutation({
    onSuccess: () => { notify.ok("أُضيفت الصيرفة"); onSuccess(); },
    onError: (e) => notify.err(e.message),
  });
  const update = trpc.exchange.update.useMutation({
    onSuccess: () => { notify.ok("حُفظت التعديلات"); onSuccess(); },
    onError: (e) => notify.err(e.message),
  });

  const submit = () => {
    if (!name.trim()) { notify.err("اسم الصيرفة مطلوب"); return; }
    if (isEdit && editing) {
      update.mutate({ id: editing.id, name: name.trim(), phone: phone || null, legacyCode: legacyCode || null, notes: notes || null });
    } else {
      create.mutate({
        name: name.trim(),
        phone: phone || null,
        legacyCode: legacyCode || null,
        notes: notes || null,
        openingBalanceIqd: openIqd || null,
        openingBalanceUsd: openUsd || null,
        openingUsdRate: openRate || null,
      });
    }
  };
  const pending = create.isPending || update.isPending;

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" dir="rtl">
      <Card className="w-full max-w-xl p-5">
        <h3 className="text-lg font-semibold mb-3">{isEdit ? "تعديل صيرفة" : "صيرفة جديدة"}</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">اسم الصيرفة *</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="مثال: صيرفة الرشيد" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">الهاتف</label>
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} dir="ltr" placeholder="+9647…" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">الرمز القديم (اختياري)</label>
            <Input value={legacyCode} onChange={(e) => setLegacyCode(e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">ملاحظات</label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>

          {!isEdit && (
            <>
              <div className="sm:col-span-2 mt-1 text-xs font-semibold text-muted-foreground border-t pt-2">
                رصيد افتتاحي (اختياري — موجب = لنا عندهم)
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">رصيد دينار افتتاحي</label>
                <Input value={openIqd} onChange={(e) => setOpenIqd(e.target.value)} dir="ltr" inputMode="decimal" placeholder="0.00" className="tabular-nums" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">رصيد دولار افتتاحي</label>
                  <Input value={openUsd} onChange={(e) => setOpenUsd(e.target.value)} dir="ltr" inputMode="decimal" placeholder="0.00" className="tabular-nums" />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">سعر كلفة الدولار</label>
                  <Input value={openRate} onChange={(e) => setOpenRate(e.target.value)} dir="ltr" inputMode="decimal" placeholder="1450" className="tabular-nums" />
                </div>
              </div>
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 mt-4">
          <Button variant="outline" onClick={onClose}>تراجع</Button>
          <Button onClick={submit} disabled={pending}>{pending ? "جارٍ…" : isEdit ? "حفظ" : "إضافة"}</Button>
        </div>
      </Card>
    </div>
  );
}
