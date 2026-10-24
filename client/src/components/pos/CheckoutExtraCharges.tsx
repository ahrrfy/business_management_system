import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/form/MoneyInput";
import { D, formatIqd } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import type {
  CheckoutChargesInput,
  CheckoutChargesResult,
} from "@shared/checkoutCharges";
import { printCheckoutAllocationReceipt } from "./printChargeReceipt";

import { checkoutExtraTotal } from "./checkoutExtraAmounts";
export function CheckoutExtraCharges(props: {
  branchId: number;
  customerId: number | null;
  channel: "POS" | "PRINT_POS" | "RECEPTION";
  value?: CheckoutChargesInput;
  onChange: (value: CheckoutChargesInput) => void;
  disabled?: boolean;
  chargeOnly?: boolean;
  onChargeOnly?: () => void;
  onSplitChargeOnly?:()=>void;
  goodsTender?: string;
  lastResult?: { result: CheckoutChargesResult; recoveryToken: string } | null;
}) {
  const [open, setOpen] = useState(false);
  const value = props.value ?? {},
    services = value.serviceCharges ?? [],
    approved = value.approvedChargeAllocations ?? [];
  const total = checkoutExtraTotal(value);
  return (
    <div className="shrink-0 max-h-56 overflow-y-auto border-b border-border px-3 py-2 space-y-2 text-xs">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={props.disabled}
        onClick={() => setOpen(!open)}
      >
        أجور إضافية{total.gt(0) ? ` — ${formatIqd(total.toFixed(2))}` : ""}
      </Button>
      {(open || services.length > 0 || approved.length > 0) && (
        <div className="space-y-2">
          {services.map((line, index) => (
            <div key={index} className="flex gap-1 items-center">
              <Input
                aria-label="بيان الخدمة الإضافية"
                value={line.description}
                disabled={props.disabled}
                onChange={(e) =>
                  props.onChange({
                    ...value,
                    serviceCharges: services.map((row, i) =>
                      i === index
                        ? { ...row, description: e.target.value }
                        : row,
                    ),
                  })
                }
                placeholder="بيان خدمة المكتبة"
                className="h-8 min-w-0"
              />
              <MoneyInput
                aria-label="مبلغ الخدمة الإضافية"
                value={line.amount}
                disabled={props.disabled}
                onChange={(amount) =>
                  props.onChange({
                    ...value,
                    serviceCharges: services.map((row, i) =>
                      i === index ? { ...row, amount } : row,
                    ),
                  })
                }
                className="h-8 w-28 shrink-0"
              />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={props.disabled}
                onClick={() =>
                  props.onChange({
                    ...value,
                    serviceCharges: services.filter((_, i) => i !== index),
                  })
                }
              >
                حذف
              </Button>
            </div>
          ))}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={props.disabled || services.length >= 50}
            onClick={() =>
              props.onChange({
                ...value,
                serviceCharges: [...services, { description: "", amount: "" }],
              })
            }
          >
            إضافة خدمة
          </Button>
          {props.customerId != null && <ApprovedCheckoutCharges key={props.lastResult?.recoveryToken} branchId={props.branchId} customerId={props.customerId} channel={props.channel} open={open} disabled={props.disabled} value={value} approved={approved} onChange={props.onChange}/> }
          <p className="text-muted-foreground">
            أجور الخدمة ضمن السقف المعتمد، بلا تكلفة خارجية. تُضاف إلى وسيلة
            القبض الأولى في العملية نفسها.
          </p>
          {total.gt(0) && (
            <p className="font-semibold">
              الأجور {formatIqd(total.toFixed(2))} · قبض الوسيلة الأولى مع
              الأجور{" "}
              {formatIqd(
                D(props.goodsTender || 0)
                  .plus(total)
                  .toFixed(2),
              )}
            </p>
          )}
          {props.chargeOnly && total.gt(0) && (
            <>
            {props.onSplitChargeOnly&&<Button type="button" size="sm" variant="outline" disabled={props.disabled} onClick={props.onSplitChargeOnly}>تقسيم قبض الأجور</Button>}
            <Button
              type="button"
              size="sm"
              disabled={props.disabled}
              onClick={props.onChargeOnly}
            >
              قبض الأجور فقط
            </Button>
            </>
          )}
        </div>
      )}
      {props.lastResult && (
        <div role="status" className="space-y-1">
          <p>
            تم القبض{" "}
            {formatIqd(
              props.lastResult.result.checkoutPaymentSummary.appliedAmount,
            )}{" "}
            · المرجع {props.lastResult.recoveryToken}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() =>
              printCheckoutAllocationReceipt(
                props.lastResult!.result,
                props.lastResult!.recoveryToken,
              )
            }
          >
            طباعة إيصال القبض والتخصيصات
          </Button>
        </div>
      )}
    </div>
  );
}

function ApprovedCheckoutCharges(props:{branchId:number;customerId:number;channel:"POS"|"PRINT_POS"|"RECEPTION";open:boolean;disabled?:boolean;value:CheckoutChargesInput;approved:NonNullable<CheckoutChargesInput["approvedChargeAllocations"]>;onChange:(value:CheckoutChargesInput)=>void}){
  const query={branchId:props.branchId,customerId:props.customerId};
  const retail=trpc.sales.checkoutChargeOptions.useQuery(query,{enabled:props.open&&props.channel==="POS",staleTime:0,refetchOnWindowFocus:false});
  const print=trpc.printPos.checkoutChargeOptions.useQuery(query,{enabled:props.open&&props.channel==="PRINT_POS",staleTime:0,refetchOnWindowFocus:false});
  const reception=trpc.reception.checkoutChargeOptions.useQuery(query,{enabled:props.open&&props.channel==="RECEPTION",staleTime:0,refetchOnWindowFocus:false});
  const options=props.channel==="POS"?retail:props.channel==="RECEPTION"?reception:print;
  return (            <div className="space-y-1">
              {options.error && <p role="alert">{options.error.message}</p>}
              {(options.data ?? []).map((row) => (
                <Button
                  key={row.id}
                  type="button"
                  variant={
                    props.approved.some((a) => a.chargeId === row.id)
                      ? "secondary"
                      : "ghost"
                  }
                  size="sm"
                  disabled={props.disabled}
                  onClick={() =>
                    props.onChange({
                      ...props.value,
                      approvedChargeAllocations: props.approved.some(
                        (a) => a.chargeId === row.id,
                      )
                        ? props.approved.filter((a) => a.chargeId !== row.id)
                        : [
                            ...props.approved,
                            {
                              chargeId: row.id,
                              expectedVersion: row.version,
                              amount: row.remainingAmount,
                            },
                          ],
                    })
                  }
                >
                  CHG-{row.id} · {row.description} ·{" "}
                  {formatIqd(row.remainingAmount)}
                </Button>
              ))}
            </div>);
}
