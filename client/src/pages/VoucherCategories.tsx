// إدارة فئات السندات — محاسب/مدير مخوّل بالخزينة، مع معالجة التصنيف التاريخي.
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AppSelect } from "@/components/ui/AppSelect";
import { PageHeader } from "@/components/PageHeader";
import {
  LoadingState,
  ErrorState,
  TableEmptyRow,
} from "@/components/PageState";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { confirm } from "@/lib/confirm";
import { notify } from "@/lib/notify";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { AlertTriangle, CheckCircle2, Edit3, Plus, RotateCcw, Wrench } from "lucide-react";
import { ListToolbar, RowActions } from "@/components/list";
import {
  isVoucherCategoryRoleCompatible,
  UNRESOLVED_DEFAULT_VOUCHER_CATEGORIES,
  voucherCategoryRoleLabel,
  voucherCategoryRoleOptionsFor,
  type VoucherCategoryPostingRole,
} from "@shared/voucherCategoryAccounting";
import { retiredVoucherCategory } from "@shared/voucherCategoryDefaults";
import {
  moduleAccessAllowed,
  type PermissionMap,
  type RoleKey,
} from "@shared/permissions";
import { selectClsFull } from "@/lib/ui/formStyles";

function unresolvedCategoryLabel(name: string): string {
  return (UNRESOLVED_DEFAULT_VOUCHER_CATEGORIES as readonly string[]).includes(
    name,
  )
    ? "تحتاج مساراً تخصصياً"
    : "غير معيّن";
}

/** الفئة الغامضة لا تُخمَّن لها حساب؛ نقول للمستخدم أين مسارها الصحيح بدل تركه أمام «غير معيّن». */
function replacementHint(name: string): string | null {
  return retiredVoucherCategory(name)?.replacement ?? null;
}

type Row = RouterOutputs["voucherCategories"]["list"][number];

// توحيد التسمية مع نموذج الإضافة/التعديل أدناه (كان BOTH يُعرَض «كلاهما» هنا و«قبض وصرف» في النموذج
// لنفس القيمة — تسمية غير متّسقة على الشاشة نفسها).
const DIR_LABEL: Record<string, string> = {
  IN: "قبض فقط",
  OUT: "صرف فقط",
  BOTH: "قبض وصرف",
};

export default function VoucherCategories() {
  const utils = trpc.useUtils();
  const list = trpc.voucherCategories.list.useQuery({ includeInactive: true });
  const unclassified = trpc.voucherCategories.unclassifiedOther.useQuery();
  const me = trpc.auth.me.useQuery();
  const canManage =
    !!me.data?.role &&
    moduleAccessAllowed(
      me.data.role as RoleKey,
      (me.data.permissionsOverride ?? null) as PermissionMap | null,
      "treasury",
      "FULL",
      ["manager", "accountant"],
    );
  const [query, setQuery] = useState("");
  const rows = list.data ?? [];
  const visibleRows = useMemo(() => {
    const q = query.trim().toLocaleLowerCase("ar");
    return q
      ? rows.filter((r) =>
          [
            r.name,
            r.description,
            DIR_LABEL[r.direction],
            voucherCategoryRoleLabel(r.postingRole),
          ].some((v) =>
            String(v ?? "")
              .toLocaleLowerCase("ar")
              .includes(q),
          ),
        )
      : rows;
  }, [rows, query]);

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [name, setName] = useState("");
  const [direction, setDirection] = useState<"IN" | "OUT" | "BOTH">("OUT");
  const [postingRole, setPostingRole] = useState<
    VoucherCategoryPostingRole | ""
  >("");
  const [description, setDescription] = useState("");
  const [sortOrder, setSortOrder] = useState<number>(100);

  const create = trpc.voucherCategories.create.useMutation({
    onSuccess: async () => {
      await utils.voucherCategories.list.invalidate();
      resetForm();
      notify.ok("أُضيفت الفئة");
    },
    onError: (e) => notify.err(e),
  });
  const update = trpc.voucherCategories.update.useMutation({
    onSuccess: async () => {
      await utils.voucherCategories.list.invalidate();
      resetForm();
      notify.ok("حُدّثت الفئة");
    },
    onError: (e) => notify.err(e),
  });
  const setActive = trpc.voucherCategories.setActive.useMutation({
    onSuccess: async () => {
      await utils.voucherCategories.list.invalidate();
      notify.ok("تَمّ التَحديث");
    },
    onError: (e) => notify.err(e),
  });
  // مخرج تشغيليّ حين تكون القائمة فارغة أو ناقصة (قاعدةٌ بُنيت بـdb:push، أو تعطيلٌ جماعيّ):
  // idempotent تماماً — يُدخل الناقص ويملأ الحساب المقابل الفارغ فقط، ولا يمسّ ما عيّنه المالك.
  const restoreDefaults = trpc.voucherCategories.restoreDefaults.useMutation({
    onSuccess: async (res) => {
      await utils.voucherCategories.list.invalidate();
      if (!res.inserted.length && !res.mapped.length) {
        notify.ok(`الفئات الافتراضية مكتملة أصلاً (${res.total} فئة)`);
        return;
      }
      notify.ok(
        `استُعيدت الفئات الافتراضية: +${res.inserted.length} جديدة، ${res.mapped.length} عُيّن حسابها`,
      );
    },
    onError: (e) => notify.err(e),
  });
  const merge = trpc.voucherCategories.merge.useMutation({
    onSuccess: async () => {
      await utils.voucherCategories.list.invalidate();
      notify.ok("تَمّ الدَمج");
      setMergingRow(null);
      setMergeTargetId("");
    },
    onError: (e) => notify.err(e),
  });
  const [historicalAssignments, setHistoricalAssignments] = useState<
    Record<number, string>
  >({});
  const assignHistorical =
    trpc.voucherCategories.assignHistoricalCategory.useMutation({
      onSuccess: async () => {
        await Promise.all([
          utils.voucherCategories.unclassifiedOther.invalidate(),
          utils.voucherCategories.list.invalidate(),
        ]);
        notify.ok("عُيّنت الفئة التاريخية وحُفظ أثر التدقيق");
      },
      onError: (e) => notify.err(e),
    });

  function resetForm() {
    setShowForm(false);
    setEditing(null);
    setName("");
    setDirection("OUT");
    setPostingRole("");
    setDescription("");
    setSortOrder(100);
  }

  function startEdit(r: Row) {
    setEditing(r);
    setName(r.name);
    setDirection(r.direction as "IN" | "OUT" | "BOTH");
    setPostingRole((r.postingRole as VoucherCategoryPostingRole | null) ?? "");
    setDescription(r.description ?? "");
    setSortOrder(r.sortOrder);
    setShowForm(true);
  }

  function submitForm() {
    if (!name.trim()) {
      notify.err("الاسم مطلوب");
      return;
    }
    if (!postingRole) {
      notify.err("الحساب المحاسبي المقابل مطلوب");
      return;
    }
    if (editing) {
      update.mutate({
        id: Number(editing.id),
        name: name.trim(),
        direction,
        postingRole,
        description: description.trim() || null,
        sortOrder,
      });
    } else {
      create.mutate({
        name: name.trim(),
        direction,
        postingRole,
        description: description.trim() || null,
        sortOrder,
      });
    }
  }

  async function confirmRestoreDefaults() {
    const ok = await confirm({
      variant: "info",
      title: "استعادة الفئات الافتراضية",
      description:
        "سَتُضاف فئات القبض والصرف الافتراضية الناقصة، ويُعيَّن الحساب المقابل للفئات التي بقيت بلا حساب. لا يُعدَّل اسمٌ ولا اتجاهٌ ولا حسابٌ عيّنته الإدارة، ولا تُفعَّل فئة عُطّلت عمداً.",
      confirmText: "استعادة",
    });
    if (!ok) return;
    restoreDefaults.mutate();
  }

  async function toggleActive(r: Row) {
    const ok = await confirm({
      variant: r.isActive ? "warning" : "info",
      title: r.isActive ? "تَعطيل الفئة" : "تَفعيل الفئة",
      description: r.isActive
        ? `سَتَختفي فئة «${r.name}» من قوائم اختيار السندات الجَديدة (السندات القَديمة تَحتفظ بربطها).`
        : `سَتَعود فئة «${r.name}» للظُهور في قوائم السندات الجَديدة.`,
      confirmText: r.isActive ? "تَعطيل" : "تَفعيل",
    });
    if (!ok) return;
    setActive.mutate({ id: Number(r.id), isActive: !r.isActive });
  }

  // دَمج فئتين — حوار بمنتقٍ بالاسم (لا رقم فئة خام يكتبه المستخدم يدوياً عبر window.prompt).
  const [mergingRow, setMergingRow] = useState<Row | null>(null);
  const [mergeTargetId, setMergeTargetId] = useState<string>("");

  function doMerge(r: Row) {
    setMergingRow(r);
    setMergeTargetId("");
  }

  const mergeCandidates = useMemo(
    () =>
      rows.filter(
        (c) =>
          c.isActive &&
          Number(c.id) !== Number(mergingRow?.id ?? -1) &&
          c.postingRole != null &&
          (mergingRow?.postingRole == null ||
            c.postingRole === mergingRow.postingRole) &&
          (c.direction === "BOTH" || c.direction === mergingRow?.direction),
      ),
    [rows, mergingRow],
  );

  const unresolvedCount = rows.filter(
    (row) =>
      (row.isActive || Number(row.usedReceiptCount ?? 0) > 0) &&
      !isVoucherCategoryRoleCompatible(row.direction, row.postingRole),
  ).length;
  const roleOptions = voucherCategoryRoleOptionsFor(direction);

  function confirmMerge() {
    if (!mergingRow || !mergeTargetId) return;
    merge.mutate({
      fromId: Number(mergingRow.id),
      toId: Number(mergeTargetId),
    });
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="فئات السندات"
        description="تصنيف سندات القبض والصرف وربط كل فئة بحساب مقابل واضح في دفتر الأستاذ."
        actions={
          <div className="flex gap-2">
            <Link href="/vouchers">
              <Button variant="outline" size="sm">
                → السندات
              </Button>
            </Link>
            {canManage && (
              <Button
                variant="outline"
                size="sm"
                disabled={restoreDefaults.isPending}
                onClick={() => void confirmRestoreDefaults()}
              >
                <RotateCcw aria-hidden className="size-4 ms-1" />
                {restoreDefaults.isPending ? "جارٍ الاستعادة…" : "استعادة الافتراضية"}
              </Button>
            )}
            {canManage && (
              <Button
                onClick={() => {
                  resetForm();
                  setShowForm(true);
                }}
                className="bg-[var(--sem-pos)] text-white hover:opacity-90"
              >
                <Plus aria-hidden className="size-4 ms-1" /> فئة جديدة
              </Button>
            )}
          </div>
        }
      />

      {!canManage && (
        <Card>
          <CardContent className="p-3 text-sm text-muted-foreground">
            عرض فقط — الإدارة والمعالجة متاحتان للمحاسب أو المدير المخوّل
            بالخزينة.
          </CardContent>
        </Card>
      )}

      {unresolvedCount > 0 && (
        <Card className="border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]">
          <CardContent className="p-3 text-sm flex items-start gap-2">
            <AlertTriangle aria-hidden className="size-4 mt-0.5 shrink-0" />
            <span>
              توجد {unresolvedCount} فئة بلا تصنيف محاسبي صالح. لا تُستعمل في
              سندات «أخرى» ولا يسمح الحارس بتحويل الدفتر إلى ACTIVE حتى تُعيّن
              أو تُعطّل.
            </span>
          </CardContent>
        </Card>
      )}

      {(unclassified.data?.length ?? 0) > 0 && (
        <Card className="border-[var(--sem-warn)]/40">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Wrench aria-hidden className="size-4" />
              معالجة سندات OTHER التاريخية غير المصنفة
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ScrollTableShell bordered={false}>
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="p-2">السند</th>
                    <th className="p-2">الطرف والوصف</th>
                    <th className="p-2 text-center">الاتجاه</th>
                    <th className="p-2 text-end">المبلغ</th>
                    <th className="p-2">المعالجة</th>
                  </tr>
                </thead>
                <tbody>
                  {(unclassified.data ?? []).map((receipt) => {
                    const receiptId = Number(receipt.id);
                    const compatible = rows.filter(
                      (category) =>
                        category.isActive &&
                        category.postingRole != null &&
                        (category.direction === "BOTH" ||
                          category.direction === receipt.direction),
                    );
                    const selected = historicalAssignments[receiptId] ?? "";
                    return (
                      <tr key={receiptId} className="border-t align-top">
                        <td className="p-2">
                          <div className="font-medium">
                            {receipt.voucherNumber ?? `#${receiptId}`}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {receipt.voucherDate
                              ? new Date(
                                  receipt.voucherDate,
                                ).toLocaleDateString("ar-IQ")
                              : "—"}
                          </div>
                        </td>
                        <td className="p-2">
                          <div>
                            {receipt.counterpartyName ?? "طرف غير مسمى"}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {receipt.description ?? "—"}
                          </div>
                        </td>
                        <td className="p-2 text-center">
                          {receipt.direction === "IN" ? "قبض" : "صرف"}
                        </td>
                        <td className="p-2 text-end tabular-nums">
                          {String(receipt.amount)}
                        </td>
                        <td className="p-2 min-w-72">
                          {receipt.specialized ? (
                            <div className="text-[var(--sem-warn)] font-medium">
                              {receipt.remediationMessage}
                            </div>
                          ) : canManage ? (
                            <div className="flex items-center gap-2">
                              <AppSelect
                                value={selected}
                                onValueChange={(value) =>
                                  setHistoricalAssignments((current) => ({
                                    ...current,
                                    [receiptId]: value,
                                  }))
                                }
                                aria-label={`فئة السند ${receipt.voucherNumber ?? receiptId}`}
                              >
                                <option value="">
                                  — اختر الفئة والحساب المقابل —
                                </option>
                                {compatible.map((category) => (
                                  <option
                                    key={Number(category.id)}
                                    value={String(category.id)}
                                  >
                                    {category.name} —{" "}
                                    {voucherCategoryRoleLabel(
                                      category.postingRole,
                                    )}
                                  </option>
                                ))}
                              </AppSelect>
                              <Button
                                size="sm"
                                disabled={
                                  !selected || assignHistorical.isPending
                                }
                                onClick={() =>
                                  assignHistorical.mutate({
                                    receiptId,
                                    voucherCategoryId: Number(selected),
                                  })
                                }
                              >
                                تعيين
                              </Button>
                            </div>
                          ) : (
                            <span className="text-muted-foreground">
                              يتطلب صلاحية خزينة كاملة
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </ScrollTableShell>
          </CardContent>
        </Card>
      )}

      {showForm && canManage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {editing ? "تَعديل فئة" : "فئة جديدة"}
            </CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>الاسم *</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="مَثلاً: إعلانات ومُلصقات"
              />
            </div>
            <div className="space-y-1">
              <Label>الاتجاه *</Label>
              <select
                className={selectClsFull}
                value={direction}
                onChange={(e) => {
                  const next = e.target.value as "IN" | "OUT" | "BOTH";
                  setDirection(next);
                  if (
                    postingRole &&
                    !isVoucherCategoryRoleCompatible(next, postingRole)
                  ) {
                    setPostingRole("");
                  }
                }}
              >
                <option value="BOTH">قبض وصرف</option>
                <option value="IN">قبض فقط</option>
                <option value="OUT">صرف فقط</option>
              </select>
            </div>
            <div className="space-y-1 md:col-span-2">
              <Label>الحساب المحاسبي المقابل *</Label>
              <AppSelect
                value={postingRole}
                onValueChange={(value) =>
                  setPostingRole(value as VoucherCategoryPostingRole | "")
                }
                aria-label="الحساب المحاسبي المقابل لفئة السند"
              >
                <option value="">— اختر حساباً معتمداً —</option>
                {roleOptions.map((option) => (
                  <option key={option.role} value={option.role}>
                    {option.label}
                  </option>
                ))}
              </AppSelect>
              <p className="text-xs text-muted-foreground">
                في القبض يكون هذا الحساب دائناً، وفي الصرف يكون مديناً. الحساب
                النقدي تحدده طريقة الدفع تلقائياً.
              </p>
            </div>
            <div className="space-y-1 md:col-span-2">
              <Label>الوَصف (اختياري)</Label>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="شَرح مُختصر للفئة"
              />
            </div>
            <div className="space-y-1">
              <Label>ترتيب العرض</Label>
              <Input
                type="number"
                value={sortOrder}
                onChange={(e) => setSortOrder(Number(e.target.value) || 0)}
              />
            </div>
            <div className="md:col-span-2 flex gap-2">
              <Button
                onClick={submitForm}
                disabled={create.isPending || update.isPending}
                className="bg-[var(--sem-pos)] text-white hover:opacity-90"
              >
                {editing ? "حفظ التَعديل" : "حفظ الفئة"}
              </Button>
              <Button variant="outline" onClick={resetForm}>
                إلغاء
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <ListToolbar
            title="فئات السندات"
            count={visibleRows.length}
            loading={list.isLoading}
            search={{
              value: query,
              onChange: setQuery,
              placeholder: "اسم الفئة، الاتجاه أو الوصف…",
            }}
            onResetFilters={() => setQuery("")}
            onRefresh={() => void list.refetch()}
            refreshing={list.isFetching}
            onPrint={() => window.print()}
            exportSpec={{
              filename: "فئات-السندات",
              rows: visibleRows,
              formats: ["xlsx", "csv"],
              columns: [
                { key: "id", header: "#" },
                { key: "name", header: "الاسم" },
                {
                  key: "direction",
                  header: "الاتجاه",
                  map: (r) => DIR_LABEL[r.direction] ?? r.direction,
                },
                {
                  key: "postingRole",
                  header: "الحساب المقابل",
                  map: (r) => voucherCategoryRoleLabel(r.postingRole),
                },
                { key: "description", header: "الوصف" },
                { key: "sortOrder", header: "الترتيب" },
                {
                  key: "isActive",
                  header: "الحالة",
                  map: (r) => (r.isActive ? "نشطة" : "معطّلة"),
                },
              ],
            }}
          />
        </CardHeader>
        <CardContent className="p-0">
          <ScrollTableShell bordered={false}>
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2 text-center">#</th>
                  <th className="p-2">الاسم</th>
                  <th className="p-2 text-center">الاتجاه</th>
                  <th className="p-2">الحساب المقابل</th>
                  <th className="p-2">الوصف</th>
                  <th className="p-2 text-center">ترتيب</th>
                  <th className="p-2 text-center">نَشِطة</th>
                  {canManage && <th className="p-2 text-center">إجراء</th>}
                </tr>
              </thead>
              <tbody>
                {list.isLoading && (
                  <tr>
                    <td colSpan={8}>
                      <LoadingState />
                    </td>
                  </tr>
                )}
                {list.isError && (
                  <tr>
                    <td colSpan={8}>
                      <ErrorState
                        message={list.error?.message}
                        onRetry={() => void list.refetch()}
                      />
                    </td>
                  </tr>
                )}
                {visibleRows.map((r) => (
                  <tr
                    key={Number(r.id)}
                    className={`border-t ${r.isActive ? "" : "opacity-60"}`}
                  >
                    <td className="p-2 text-center text-xs text-muted-foreground">
                      {Number(r.id)}
                    </td>
                    <td className="p-2 font-medium">{r.name}</td>
                    <td className="p-2 text-center text-xs">
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 ${
                          r.direction === "IN"
                            ? "badge-status-active"
                            : r.direction === "OUT"
                              ? "badge-status-cancelled"
                              : "bg-[var(--sem-info-bg)] text-[var(--sem-info)]"
                        }`}
                      >
                        {DIR_LABEL[r.direction]}
                      </span>
                    </td>
                    <td className="p-2 text-xs">
                      {isVoucherCategoryRoleCompatible(
                        r.direction,
                        r.postingRole,
                      ) ? (
                        <span className="inline-flex items-center gap-1 text-[var(--sem-pos)]">
                          <CheckCircle2 aria-hidden className="size-3.5" />
                          {voucherCategoryRoleLabel(r.postingRole)}
                        </span>
                      ) : (
                        <span className="inline-flex flex-col gap-0.5">
                          <span className="inline-flex items-center gap-1 text-[var(--sem-warn)] font-medium">
                            <AlertTriangle aria-hidden className="size-3.5" />{" "}
                            {unresolvedCategoryLabel(r.name)}
                          </span>
                          {replacementHint(r.name) && (
                            <span className="text-muted-foreground">
                              البديل: {replacementHint(r.name)}
                            </span>
                          )}
                        </span>
                      )}
                    </td>
                    <td className="p-2 text-xs text-muted-foreground">
                      {r.description ?? "—"}
                    </td>
                    <td className="p-2 text-center text-xs tabular-nums">
                      {r.sortOrder}
                    </td>
                    <td className="p-2 text-center text-xs">
                      {r.isActive ? "نعم" : "لا"}
                    </td>
                    {canManage && (
                      <td className="p-2 text-center">
                        <RowActions
                          mode="menu"
                          actions={[
                            {
                              key: "edit",
                              kind: "edit",
                              label: "تعديل",
                              icon: Edit3,
                              onSelect: () => startEdit(r),
                              gate: {
                                roles: ["manager", "accountant"],
                                module: "treasury",
                                level: "FULL",
                              },
                            },
                            {
                              key: "toggle",
                              kind: "approve",
                              label: r.isActive ? "تعطيل" : "تفعيل",
                              variant: r.isActive ? "destructive" : "default",
                              onSelect: () => void toggleActive(r),
                              gate: {
                                roles: ["manager", "accountant"],
                                module: "treasury",
                                level: "FULL",
                              },
                            },
                            {
                              key: "merge",
                              kind: "reverse",
                              label: "دمج",
                              hidden: !r.isActive,
                              onSelect: () => void doMerge(r),
                              gate: {
                                roles: ["manager", "accountant"],
                                module: "treasury",
                                level: "FULL",
                              },
                            },
                          ]}
                        />
                      </td>
                    )}
                  </tr>
                ))}
                {!list.isLoading && visibleRows.length === 0 && (
                  <TableEmptyRow colSpan={8} message="لا فئات حتى الآن." />
                )}
              </tbody>
            </table>
          </ScrollTableShell>
        </CardContent>
      </Card>

      {/* دمج فئتين — منتقٍ بالاسم بدل رقم فئة خام (كان window.prompt يطلب رقماً يدوياً). */}
      <Dialog
        open={mergingRow != null}
        onOpenChange={(open) => {
          if (!open) {
            setMergingRow(null);
            setMergeTargetId("");
          }
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>دمج فئة «{mergingRow?.name}»</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            كل سندات «{mergingRow?.name}» سَتُنقل إلى الفئة المُختارة وتُعطَّل
            الفئة الحالية. هذا الإجراء لا يُمكن التراجع عنه.
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="merge-target">الفئة الهدف *</Label>
            <AppSelect
              id="merge-target"
              value={mergeTargetId}
              onValueChange={setMergeTargetId}
              placeholder="— اختر الفئة الهدف —"
            >
              <option value="">— اختر الفئة الهدف —</option>
              {mergeCandidates.map((c) => (
                <option key={Number(c.id)} value={String(c.id)}>
                  {c.name}
                </option>
              ))}
            </AppSelect>
            {mergeCandidates.length === 0 && (
              <p className="text-xs text-muted-foreground">
                لا فئات نشِطة أخرى للدمج فيها.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setMergingRow(null);
                setMergeTargetId("");
              }}
            >
              إلغاء
            </Button>
            <Button
              variant="destructive"
              disabled={!mergeTargetId || merge.isPending}
              onClick={confirmMerge}
            >
              {merge.isPending ? "جارٍ الدمج…" : "دمج"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
