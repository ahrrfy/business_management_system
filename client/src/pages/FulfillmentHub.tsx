import { useEffect, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { ClipboardList, PackageCheck, ReceiptText } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RequestsWorkspace } from "@/components/fulfillment/RequestsWorkspace";
import { ChargesWorkspace } from "@/components/fulfillment/ChargesWorkspace";
import AftercareWorkspace from "@/components/fulfillment/AftercareWorkspace";
import { DeliveryPaymentRefunds } from "@/components/delivery/DeliveryFeeRefunds";
import { ChargeExcessRefundWorkspace } from "@/components/fulfillment/ChargeExcessRefundWorkspace";
import { trpc } from "@/lib/trpc";
import { AppSelect } from "@/components/ui/AppSelect";

function sectionFromSearch(search: string) {
  const section = new URLSearchParams(search).get("kind");
  return section === "charges" ||
    section === "aftercare" ||
    section === "refunds"
    ? section
    : "requests";
}

function PaymentRefundWorkspace() {
  const me = trpc.auth.me.useQuery();
  const branches = trpc.branches.list.useQuery();
  const [selectedBranch, setSelectedBranch] = useState("");
  const branchId = Number(selectedBranch || me.data?.branchId) || null;
  return (
    <div className="space-y-3">
      <AppSelect
        aria-label="فرع رد المدفوعات"
        value={branchId ? String(branchId) : ""}
        onValueChange={setSelectedBranch}
      >
        <option value="">اختر الفرع</option>
        {(branches.data ?? [])
          .filter(
            (branch) =>
              me.data?.role === "admin" || branch.id === me.data?.branchId,
          )
          .map((branch) => (
            <option key={branch.id} value={String(branch.id)}>
              {branch.name}
            </option>
          ))}
      </AppSelect>
      {branchId ? (
        <DeliveryPaymentRefunds key={branchId} branchId={branchId} />
      ) : (
        <p className="text-sm text-muted-foreground">
          اختر الفرع لعرض إيصالات الاسترداد.
        </p>
      )}
      <ChargeExcessRefundWorkspace />
    </div>
  );
}

export default function FulfillmentHub() {
  const search = useSearch();
  const [pathname, navigate] = useLocation();
  const [section, setSection] = useState(() => sectionFromSearch(search));
  useEffect(() => setSection(sectionFromSearch(search)), [search]);
  const changeSection = (value: string) => {
    setSection(value);
    const params = new URLSearchParams(search);
    params.set("tab", "fulfillment");
    params.set("kind", value);
    navigate(`${pathname}?${params.toString()}`, { replace: true });
  };
  return (
    <div className="space-y-3 p-3 md:p-4" dir="rtl">
      <PageHeader
        title="التجهيز والأجور ومعالجة النقص"
        description="اجمع مستندات العميل للتوصيل، وسجّل الأجور، وتابع استكمال النقص والمعالجة المرتبطة بأصل البيع."
        icon={<PackageCheck aria-hidden className="size-5 text-primary" />}
      />
      <Tabs value={section} onValueChange={changeSection} dir="rtl">
        <TabsList className="flex h-auto flex-wrap justify-start gap-1">
          <TabsTrigger value="requests" className="gap-1.5">
            <ClipboardList aria-hidden className="size-4" />
            طلبات التوصيل
          </TabsTrigger>
          <TabsTrigger value="charges" className="gap-1.5">
            <ReceiptText aria-hidden className="size-4" />
            الأجور الإضافية
          </TabsTrigger>
          <TabsTrigger value="aftercare" className="gap-1.5">
            <PackageCheck aria-hidden className="size-4" />
            معالجة ما بعد البيع
          </TabsTrigger>
          <TabsTrigger value="refunds" className="gap-1.5">
            <ReceiptText aria-hidden className="size-4" />
            رد المدفوعات
          </TabsTrigger>
        </TabsList>
        <TabsContent value="requests">
          <RequestsWorkspace />
        </TabsContent>
        <TabsContent value="charges">
          <ChargesWorkspace />
        </TabsContent>
        <TabsContent value="aftercare">
          <AftercareWorkspace />
        </TabsContent>
        <TabsContent value="refunds">
          <PaymentRefundWorkspace />
        </TabsContent>
      </Tabs>
    </div>
  );
}
