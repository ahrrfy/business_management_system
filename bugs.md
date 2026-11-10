# Bug Report — Al-Ro'ya Al-Arabiya Business Management System (`business_management_system`) — 2026-11-07

## Summary
- Critical: 0 open, 24 fixed
- Intermediate: 0 open, 20 fixed
- Normal: 0 open, 6 fixed

---

## 🔴 Critical
*(0 open — all 24 critical bugs resolved and verified under `## ✅ Resolved` below.)*

---

## 🟡 Intermediate
*(0 open — all 20 intermediate bugs resolved and verified under `## ✅ Resolved` below.)*

---

## 🟢 Normal
*(0 open — all 6 normal bugs resolved and verified under `## ✅ Resolved` below.)*

---

## ✅ Resolved

### [🔴 Critical] BUG-001: HR employee statement & monthly attendance report count future days of the current month as `absent`
- **File:** `server/services/hr/attendancePay.ts:154-205`, `server/services/hr/employeeStatement.ts:392-415`, `server/services/hr/monthlyAttendanceReport.ts:331-355`
- **Issue:** `computeAttendancePay` iterates across every calendar day in `month` (`YYYY-MM-01` .. `YYYY-MM-30/31`) without an `asOfDate` ceiling for an active in-progress month. Every future workday after today (`Asia/Baghdad`) has no attendance record and is immediately classified as `state: "absent"`, inflating `absentDays` (e.g., `20 يوم` on November 7) and `unpaidHours`.
- **Trigger:** Open `/hr/employees/:id` or the monthly attendance report on any day mid-month for the current Baghdad month (`YYYY-MM`).
- **Impact:** Massive false absence counts (`20 يوم` on day 7 of the month), misleading scheduled vs unpaid hours, and alarming red/amber metrics for active employees.
- **Suggested Fix:** Add optional `asOfDate?: string | null` to `AttendancePayInput` in `attendancePay.ts` (defaulting to `null` so historical/full-month payroll runs and unit tests remain unchanged), expose `scheduledHoursToDate` and `isPartialMonth`, and pass Baghdad `todayYmd` in `getEmployeeStatement` and `getMonthlyAttendanceReport` for the live current month (and empty future months).
- **Status:** Fixed (2026-11-07 — verified via TypeScript `tsc --noEmit`, 49 architecture guards & Vitest regression suites)

### [🔴 Critical] BUG-002: Active today check-in punch (`checkIn != null && checkOut == null`) is misclassified as a missing-checkout violation (`بصمة انصراف ناقصة`) and triggers legacy self-healing
- **File:** `server/services/hr/attendancePay.ts:229-243`, `server/services/hr/employeeStatement.ts:298-309,667`, `client/src/components/hr/statement/useEmployeeStatement.ts:82-94`
- **Issue:** When an employee punches in today (e.g., `14:05` on `2026-11-07`) and is still actively working their shift, `computeAttendancePay` marks the day `state: "open"` (`بصمة انصراف ناقصة`), increments `openDays`, illuminates the top `needsReview` warning banner, and `rowNeedsLegacyHealing` flags `needsHealing = true` (which also attempts an automatic `recomputeMonth` mutation without checking whether a draft payroll run or self-record SoD blocks it).
- **Trigger:** View `/hr/employees/:id` while an employee is currently clocked in during today's shift (`Asia/Baghdad`).
- **Impact:** False missing-punch warning banners during normal working hours, confusing `بصمة انصراف ناقصة` badge on active shifts, and unnecessary/failing background `recomputeMonth` mutations.
- **Suggested Fix:** Add optional `inProgressDates?: ReadonlySet<string>` to `AttendancePayInput` and `"inProgress"` to `AttendanceDayRowState` (`"قيد الدوام الآن"`). Populate `inProgressDates` with `todayYmd` in `getEmployeeStatement` (when `!confirmedAttendanceOnly`) and `getMonthlyAttendanceReport` when today's punch has `checkIn` without `checkOut` (keeping `generatePayroll` and `confirmedAttendanceOnly` strict!). Exclude today's active open punch from `rowNeedsLegacyHealing`, check for draft payroll runs, and skip `recomputeMonth` when viewing one's own employee profile.
- **Status:** Fixed (2026-11-07 — verified via TypeScript `tsc --noEmit`, 49 architecture guards & Vitest regression suites)

### [🔴 Critical] BUG-003: Hourly employee daily statement rows apply 1.5x overtime & float math while `amountDue` and `generatePayroll` pay 1.0x integer IQD
- **File:** `server/services/hr/attendancePay.ts:276-286`, `server/services/hr/employeeStatement.ts:324,337,427`, `server/services/hr/monthlyAttendanceReport.ts:261,271,293,362`
- **Issue:** For `payType === "hourly"`, `computeAttendancePay` splits worked hours into `workedRegular` + `overtimeHours` at `1.5x` (`OVERTIME_MULTIPLIER`), whereas `projectAttendanceWage` and `generatePayroll` pay all worked hours at `1.0x` (`Math.round(rate * workedHours)`). In addition, `employeeStatement.ts` and `monthlyAttendanceReport.ts` accumulate `actualPaid` / `sum` using IEEE-754 JS `number` (`+`) instead of `Decimal`.
- **Trigger:** Open the attendance statement or monthly report for any hourly-paid employee who works beyond daily template hours, or sum multi-row decimal amounts.
- **Impact:** The sum of daily `totalAmount` cells in the statement table disagrees with the summary `amountDue` and actual payslip, violating financial reconciliation invariants.
- **Suggested Fix:** In `computeAttendancePay`, when `input.payType === "hourly"`, compute daily pay at `1.0x` (`overtimeHours = 0`, `overtimeAmount = 0`, `regularAmount = round(rate * netWorkedHours)`) matching `projectAttendanceWage` and `generatePayroll`; replace float sums in `employeeStatement.ts` and `monthlyAttendanceReport.ts` with `Decimal` (`money` / `round2`).
- **Status:** Fixed (2026-11-07 — verified via TypeScript `tsc --noEmit`, 49 architecture guards & Vitest regression suites)

### [🔴 Critical] BUG-004: Manual `attendance.status === "LEAVE"` rows without a `leaveRequests` record are deducted as unpaid `absent` days
- **File:** `server/services/hr/employeeStatement.ts:395-408`, `server/services/hr/monthlyAttendanceReport.ts:331-345`, `server/services/payroll/generate.ts:359-394`
- **Issue:** HR managers can set a day's status to `LEAVE` (`إجازة`) directly via the manual attendance correction dialog (`AttendanceCorrectionDialog`), which writes `attendance.status = "LEAVE"` without creating a row in `leaveRequests`. However, `paidLeaveDates` is populated solely from `leaveRequests`, so manual `LEAVE` rows fall through into `state: "absent"` and lose a full day's pay.
- **Trigger:** Correct an employee's day to `إجازة` (`LEAVE`) in `/hr/employees/:id` or `/hr/attendance` without submitting a separate leave request, then view the statement or generate payroll.
- **Impact:** Employees on manually recorded leave are penalized as absent and underpaid in payroll runs.
- **Suggested Fix:** Add dates with `attendance.status === "LEAVE"` (that are not in `unpaidLeaveDates`) into `paidLeaveDates` consistently across `employeeStatement.ts`, `monthlyAttendanceReport.ts`, and `payroll/generate.ts`.
- **Status:** Fixed (2026-11-07 — verified via TypeScript `tsc --noEmit`, 49 architecture guards & Vitest regression suites)

### [🔴 Critical] BUG-005: `payroll.myPayslip` ignores `revisionNo` on revised payroll runs and `HrPayslip.tsx` labels cancelled runs as `"معتمد"`
- **File:** `server/routers/payrollRouter.ts:128-196`, `client/src/pages/HrPayslip.tsx:63-64,71,147`
- **Issue:** `myPayslip` queries `payrollItems` without filtering `eq(payrollItems.revisionNo, payrollRuns.revisionNo)`, returning superseded `revisionNo = 0` rows or mismatched penalty lines after a run is unapproved and regenerated. Furthermore, `HrPayslip.tsx:71` uses a ternary `runStatus === "draft" ? "مسودة" : runStatus === "paid" ? "مصروف" : "معتمد"`, displaying `"معتمد"` (Approved) on `"cancelled"` payroll runs!
- **Trigger:** Unapprove and regenerate a payroll run (incrementing `revisionNo`), or cancel a run, then open `/hr/my-payslip`.
- **Impact:** Employees see outdated salary figures or see a cancelled payslip stamped `"معتمد"`.
- **Suggested Fix:** Join/filter `eq(payrollItems.revisionNo, payrollRuns.revisionNo)` in `payrollRouter.ts` (`myPayslip`), include `fatherName` and `grandfatherName`, and explicitly map `cancelled` to `"ملغى"` in `HrPayslip.tsx`.
- **Status:** Fixed (2026-11-07 — verified via TypeScript `tsc --noEmit`, 49 architecture guards & Vitest regression suites)

### [🔴 Critical] BUG-006: `upsertManualAttendance` allows overwriting an existing attendance record belonging to another branch
- **File:** `server/services/attendanceService.ts:1153-1163`
- **Issue:** While cross-branch shift coverage legitimately allows creating a *new* attendance record (`existing == null`) scoped to the manager's branch (`GAP-07`), `upsertManualAttendance` fails to check `existing.branchId` when `existing != null` and `input.scopedBranchId != null`, allowing a branch manager to overwrite an existing attendance punch recorded at a different branch.
- **Trigger:** Branch B manager submits `upsertManualAttendance` for an employee on a date where Branch A already recorded an attendance row.
- **Impact:** Cross-branch attendance tampering violating branch isolation (`CLAUDE.md §6`).
- **Suggested Fix:** When `existing != null && input.scopedBranchId != null && existing.branchId != null && Number(existing.branchId) !== Number(input.scopedBranchId)`, throw an authorization error blocking cross-branch overwrite while preserving `existing == null` cross-branch shift coverage.
- **Status:** Fixed (2026-11-07 — verified via TypeScript `tsc --noEmit`, 49 architecture guards & Vitest regression suites)

### [🔴 Critical] BUG-007: `CrmHub.tsx` ignores `operationPolicy` and mounts `<CrmOverview />` unconditionally for restricted users (`403 FORBIDDEN`)
- **File:** `client/src/pages/CrmHub.tsx:127,666,773,851`
- **Issue:** `CrmHub.tsx` calls `canSeeGate(..., userRole, customRole)` without passing `effectiveOperationPolicy(me.data)`, and defaults `activeWing` to `"overview"` without checking `canSeeGate(OVERVIEW_GATE, ...)`, mounting `<CrmOverview />` unconditionally and firing restricted analytics queries that fail with `403 FORBIDDEN`.
- **Trigger:** Open `/crm` as a custom-policy user or support/sales staff without `OVERVIEW_GATE` access.
- **Impact:** Broken CRM landing experience with red `403` error states and hidden/mis-gated tabs.
- **Suggested Fix:** Pass `effectiveOperationPolicy(me.data)` to every `canSeeGate` call in `CrmHub.tsx`, gate the `"overview"` wing tab and content on `canSeeOverview`, and default `activeWing` to the first permitted wing (`"overview"`, `"care"`, or `"sales"`).
- **Status:** Fixed (2026-11-07 — verified via TypeScript `tsc --noEmit`, 49 architecture guards & Vitest regression suites)

### [🔴 Critical] BUG-008: `hasModuleOperation` in `navVisibility.ts` ignores `level === "FULL"` and `managerOnly` under active `operationPolicy`
- **File:** `client/src/lib/navVisibility.ts:45-92`
- **Issue:** When `operationPolicy` is active and a `NavGate` specifies `{ module, level: "FULL" }` (without an explicit `operations` list) or `{ managerOnly: true }`, `hasModuleOperation` returns `true` if *any* read-only query operation in that module is allowed, exposing write-only/manager screens in navigation that subsequently fail with `403 FORBIDDEN`.
- **Trigger:** Assign a user a custom `operationPolicy` with `READ`-only query grants in a module and inspect visible sidebar/hub actions gated by `{ module, level: "FULL" }` or `{ managerOnly: true }`.
- **Impact:** Screens and buttons unexpectedly appear in UI despite read-only permissions, failing on click.
- **Suggested Fix:** In `hasModuleOperation(policy, mod, level)` (used when `gate.operations` is not explicitly provided), require `entry.level === "FULL" || entry.kind === "mutation"` when `level === "FULL"`, and enforce `role === "manager"` when `gate.managerOnly` is set without explicit `operations`.
- **Status:** Fixed (2026-11-07 — verified via TypeScript `tsc --noEmit`, 49 architecture guards & Vitest regression suites)

### [🔴 Critical] BUG-009: `SALES_RETURN` requests with `CARD` refund deadlock permanently in `SalesControlApprovals.tsx` and drop `reference` for walk-in customers
- **File:** `client/src/pages/SalesControlApprovals.tsx:844-847,1015-1041`, `server/services/sale/controlRequests.ts:895-916`
- **Issue:** Staff can submit a `SALES_RETURN` request with `CARD` refund without a terminal reference (`reference` is optional at request time), locking the invoice via `activeInvoiceUq`. In `SalesControlApprovals.tsx`, the card terminal reference input is gated on `request.requestType === "SALES_CANCEL"` only, so `approveOne` always sends `cashRouting: null` for `SALES_RETURN`, causing `returnSaleInTx` to throw `BAD_REQUEST` (*"مرجع العملية من جهاز الدفع لم يصل"*). Furthermore, `applyCashRouting` in `controlRequests.ts:905-914` only copies `routing.reference` onto `next.refund` and drops it for walk-in `next.resolution` (`kind === "CARD"`).
- **Trigger:** Submit a `SALES_RETURN` for a card-paid invoice (registered or walk-in customer) without pre-filling the card slip reference, then attempt to approve it as manager in `/sales/control-approvals`.
- **Impact:** Invoice is locked in `PENDING` state with zero way to approve it from the UI.
- **Suggested Fix:** Enable the card reference input and `cashRouting: { reference }` payload for `SALES_RETURN` when `payload.refund?.method === "CARD"` or `payload.resolution?.kind === "CARD"` in `SalesControlApprovals.tsx`, and copy `routing.reference` onto `next.resolution` in `applyCashRouting`.
- **Status:** Fixed (2026-11-07 — verified via TypeScript `tsc --noEmit`, 49 architecture guards & Vitest regression suites)

### [🔴 Critical] BUG-010: Walk-in (`customerId == null`) non-cash work orders deadlock in `REVERSE_DELIVERY`, and `PENDING_APPROVAL` refund receipts deadlock once `wo.status` advances
- **File:** `server/services/reversal/executors/workOrderDelivery.ts:188-197`, `server/services/workOrder/cancel.ts:1128-1133`, `server/services/workOrder/fulfillment.ts:66-98`, `server/services/workOrder/deliveryFeeRefund.ts:166-169`
- **Issue:** (a) Reception commits allow walk-in work orders (`customerId: null`) paid by card/transfer, and `getWorkOrderReverseDeliveryPreflight` marks them `eligible: true`, yet `workOrderDeliveryRefundExecutor` throws `PRECONDITION_FAILED` demanding a linked customer or cash refund (both forbidden by `workOrder/update.ts` and `reverseDelivery.ts`), despite line 212 already supporting `partyType: "OTHER", partyId: null`. (b) `approveWorkOrderCancellationRefund` (`cancel.ts:1128-1133`) rejects approving a `PENDING_APPROVAL` refund receipt unless `wo.status` is `CANCELLED` or `READY`, stranding unspent-delivery-fee or reopened-order bank refunds once the order is delivered; and `fulfillment.ts:96` fails to clear `deliveryFeeCollection` when a `PENDING_APPROVAL` refund receipt is queued.
- **Trigger:** Approve `REVERSE_DELIVERY` on a walk-in non-cash work order, or switch a card-paid delivery work order to counter pickup, deliver it, and then approve the pending refund receipt.
- **Impact:** Permanently stuck control requests and un-approvable customer refund liabilities.
- **Suggested Fix:** Allow `partyType: "OTHER", partyId: null` deferred non-cash refund receipts in `workOrderDelivery.ts` (matching `workOrder/cancel.ts:643-648`), decouple `approveWorkOrderCancellationRefund` from `wo.status` once the `PENDING_APPROVAL` receipt itself is locked and verified, and clear `deliveryFeeCollection` when `refundUnspentCounterDeliveryFeeTx` queues a `PENDING_APPROVAL` receipt.
- **Status:** Fixed (2026-11-07 — verified via TypeScript `tsc --noEmit`, 49 architecture guards & Vitest regression suites)

### [🔴 Critical] BUG-011: `REVERSE_DELIVERY` with `reopen: true` refunds work order deposits without zeroing `workOrders.deposit` or recording `REFUND` in `orderPayments`
- **File:** `server/services/workOrder/reverseDelivery.ts:694-702`, `server/services/workOrder/depositReceiptSet.ts:10-27`
- **Issue:** When reversing delivery with `reopen: true`, `reverseWorkOrderDeliveryEffectsInTx` refunds all collected amounts including the initial deposit (`OTHER_LIABILITY -> CASH` `OUT` receipt), but `reverseDelivery.ts:694-698` resets `status = "READY"` while leaving `workOrders.deposit` and `depositReceiptId` intact, inserting no `REFUND` rows into `orderPayments`, and `loadWorkOrderDepositReceiptSet` sums `IN` deposit receipts without subtracting `OUT` refunds.
- **Trigger:** Create a work order with a deposit, deliver it, execute `REVERSE_DELIVERY` with `reopen: true`, and then either re-deliver or cancel the work order.
- **Impact:** Double refund of the deposit from the cash drawer on cancellation, or under-collection + negative `OTHER_LIABILITY` balance on re-delivery.
- **Suggested Fix:** When `input.reopen === true` and deposit sources are refunded/queued for refund, zero `deposit: "0.00"`, `depositReceiptId: null`, `paymentMethod: null` on `workOrders`, append `REFUND` rows to `orderPayments` if reception draft allocations existed, and make `loadWorkOrderDepositReceiptSet` account for reversal `OUT` receipts.
- **Status:** Fixed (2026-11-07 — verified via TypeScript `tsc --noEmit`, 49 architecture guards & Vitest regression suites)

### [🔴 Critical] BUG-012: `PrintPOS.tsx` & `HeldOrdersDrawer.tsx` fail on held-sale modification and collection due to 4 payload/channel/permission mismatches
- **File:** `client/src/pages/PrintPOS.tsx:580-592,854-880`, `client/src/components/print-pos/HeldOrdersDrawer.tsx:179-182,284-328`, `server/routers/printPosRouter.ts:257-261,500-508,560-576`
- **Issue:** (1) `PrintPOS.tsx:870-878` sends both `additionalPayment` and `overpayHandling: "CASH_REFUND"` to `correctHeldSale`, which `correctSaleInTx` (`sale/correct.ts:191`) immediately rejects with `BAD_REQUEST`; `submit(true)` also ignores `forceFullPayment` when `editingHeldInvoiceId` is set. (2) External payment confirmation in `PrintPOS.tsx:580` uses channel `"PRINT_POS"` and full `total` instead of `"SALES_COLLECTION"` and `additionalPaid`. (3) `printPosRouter.ts` omits `shiftId` in `correctHeldSale` and `listHeldSales` mixes retail POS credit invoices with `PRINT_SERVICES` invoices. (4) `HeldOrdersDrawer.tsx` calls `reception.collectOnInvoice` (`workorders:FULL`) and `sales.initiateExternalPayment` (`salesWriteProcedure` + `"POS"` channel), failing with `FORBIDDEN` / `CONFLICT` for `print_cashier`.
- **Trigger:** Hold an order in `/print-pos`, then attempt to edit & pay the difference or collect payment from `HeldOrdersDrawer`.
- **Impact:** Print POS cashiers cannot collect or edit held orders at all.
- **Suggested Fix:** Fix `PrintPOS.tsx` to honor `forceFullPayment`, send `overpayHandling` only when no `additionalPayment` is present and new total < prior paid, and use `"SALES_COLLECTION"` for delta external payments; scope `printPos.listHeldSales` to `PRINT_SERVICES` shifts, pass active `PRINT_SERVICES` `shiftId` in `correctHeldSale`, and expose `printPos.collectHeldSale` / `printPos.initiateHeldCollectionPayment` under `posCashierProcedure` for `HeldOrdersDrawer.tsx`.
- **Status:** Fixed (2026-11-07 — verified via TypeScript `tsc --noEmit`, 49 architecture guards & Vitest regression suites)

### [🔴 Critical] BUG-013: Branch managers (`role: "manager"`) hit a self-approval `SOD-03` deadlock when delivering work orders on customer credit
- **File:** `client/src/pages/WorkOrderDetail.tsx:1070-1088,1110-1125`, `client/src/components/workOrders/WorkOrderDeliverDialog.tsx:149-165`, `client/src/pages/reception/ReceptionHandoverPage.tsx:414,896-900`
- **Issue:** Backend `deliverWorkOrderInTx` (`deliver.ts:199,234`) and `workOrderRouter.ts:2321` explicitly authorize `manager` and `admin` actors to deliver with `addToCustomerDebt: true` directly *without* `managerApproval`. Yet all 3 UI screens unconditionally open `ManagerApprovalDialog` and submit `managerApproval`; when a branch manager (`isOwner: false`) enters their own credentials, `verifyManagerApproval` (`saleRouter.ts:564`) rejects with `FORBIDDEN` (`SOD-03: لا يجوز للمستخدم اعتماد عمليته بنفسه`). Additionally, `ReceptionHandoverPage.tsx:897` disables the credit-delivery button when `!shift` even though zero cash is touched.
- **Trigger:** Log in as a branch `manager` (`isOwner: false`) and click «إضافة المتبقي لذمة العميل» on any ready work order.
- **Impact:** A sole branch manager is completely locked out of credit handover on work orders.
- **Suggested Fix:** Skip `ManagerApprovalDialog` and submit `addToCustomerDebt: true` directly when `me.data?.role === "admin" || me.data?.role === "manager"`, and remove `!shift` from disabling zero-cash credit delivery in `ReceptionHandoverPage.tsx`.
- **Status:** Fixed (2026-11-07 — verified via TypeScript `tsc --noEmit`, 49 architecture guards & Vitest regression suites)

### [🔴 Critical] BUG-014: Shift close accepts unverified `managerApprovedByUserId` from a raw `<select>` dropdown without manager authentication
- **File:** `server/routers/shiftRouter.ts:342,416-449`, `client/src/components/pos/ShiftCloseDialog.tsx:134-141,273`, `client/src/components/reception/ReceptionShiftCloseDialog.tsx:109-116,251`
- **Issue:** Despite `shiftService.ts:230` stating that `managerApprovedByUserId` must never be trusted from client payload without credential verification, `shiftRouter.close` accepts `managerApprovedByUserId: z.number()` and only checks that the user ID belongs to an active manager/admin in DB—without verifying password, PIN, or badge! Both `ShiftCloseDialog.tsx` and `ReceptionShiftCloseDialog.tsx` render a raw HTML `<select>` listing manager names so any cashier can self-approve arbitrary drawer shortages under a manager's name.
- **Trigger:** Close a POS, Print, or Reception shift with a cash shortage exceeding governance threshold as a cashier and pick any manager from the `<select>` dropdown.
- **Impact:** Complete bypass of cash shortage governance (`enforceCashGovernance: false`) and forged manager attribution in audit logs, plus raw `<select>` UI violation.
- **Suggested Fix:** Add `managerApproval: managerApprovalSchema.optional()` verified via `verifyManagerApproval` in `shiftRouter.close` (rejecting unauthenticated `managerApprovedByUserId` from non-elevated callers), and replace the raw `<select>` in `ShiftCloseDialog.tsx` and `ReceptionShiftCloseDialog.tsx` with `ManagerApprovalDialog`.
- **Status:** Fixed (2026-11-07 — verified via TypeScript `tsc --noEmit`, 49 architecture guards & Vitest regression suites)

### [🔴 Critical] BUG-015: `enrichShiftListProvenance` subtracts closing handover receipt (`CH-`) as a mid-shift drop, breaking reconciliation on every closed shift with cash
- **File:** `server/services/shiftService.ts:1658-1666`
- **Issue:** When a shift closes with `countedCash > 0`, `closeShift` creates a closing treasury handover receipt with prefix `CH-`. `computeExpectedCash` (`shiftService.ts:991-994`) excludes `CH-` from `expectedCash`, but `enrichShiftListProvenance` (`shiftService.ts:1659`) treats `ref.startsWith("CH-")` as a mid-shift cash drop (`drops`) and subtracts it from `subItems`, while also lumping non-invoice `OUT` receipts into `refunds`.
- **Trigger:** Close any shift with `countedCash > 0` and open `/shifts`.
- **Impact:** Every closed shift with cash shows `reconciled: false` and a false discrepancy equal to `countedCash`.
- **Suggested Fix:** Exclude `CH-` closing handover receipts from `drops` in `enrichShiftListProvenance` (matching `computeExpectedCash`) and separate `r.invoiceId != null` (`refunds`) from `otherOut`.
- **Status:** Fixed (2026-11-07 — verified via TypeScript `tsc --noEmit`, 49 architecture guards & Vitest regression suites)

### [🔴 Critical] BUG-016: Purchase orders saved with `taxRate > 0` deadlock permanently upon `decideControl` full receipt approval
- **File:** `client/src/pages/PurchaseNew.tsx:782-797`, `client/src/pages/PurchaseEdit.tsx:559-611`, `server/services/purchase/order.ts:620-655`
- **Issue:** Iraq purchase policy (`CLAUDE.md §1, §6`) mandates 0% VAT on purchases, and the atomic `decideControl` (`confirmedFullReceipt: true`) GRNI/auto-invoice pipeline rejects `taxAmount > 0`. However, `PurchaseNew` / `PurchaseEdit` and `createOrder` / `updateOrder` allow `taxRate > 0` to be saved and sent (`SENT`), creating an `APPROVE_REVISION` request that always crashes at reviewer approval.
- **Trigger:** Enter a non-zero tax rate on a purchase order, confirm/send it, and click approve as reviewer.
- **Impact:** Stuck `SENT` purchase order that cannot be approved/received.
- **Suggested Fix:** Lock purchase order tax rate to `0` in `PurchaseNew.tsx` / `PurchaseEdit.tsx` and reject non-zero purchase tax up front in `order.ts` (`createOrder` / `updateOrder`) with a clear `appErrorMessage` before entering `SENT`.
- **Status:** Fixed (2026-11-07 — verified via TypeScript `tsc --noEmit`, 49 architecture guards & Vitest regression suites)

### [🔴 Critical] BUG-017: `ProductEdit.tsx` treats single-variant bundles (`isBundle === true`) as simple stocked products, hiding `<BundleRecipeCard>`
- **File:** `client/src/pages/ProductEdit.tsx:203-211`, `server/services/catalog/productUpdateGuards.ts:104-130`
- **Issue:** `ProductEdit.tsx:203` computes `isSimple = variants.length === 1 && variants[0].isDefault && ...` without checking `!product.data.isBundle`. Since bundles always have a single default variant, opening any bundle in `/products/:id/edit` mounts `SimpleProductEditForm` instead of the bundle editor, hiding `<BundleRecipeCard>` completely! Also `productUpdateGuards.ts` fails to reject setting `isService` or `showInPrintPos` on bundles.
- **Trigger:** Navigate to `/products/:id/edit` for any bundle (`بكج`) product.
- **Impact:** Bundle components/recipes disappear from the edit screen and cannot be maintained.
- **Suggested Fix:** Add `&& !product.data.isBundle` to `isSimple` in `ProductEdit.tsx`, and guard against `isService` / `showInPrintPos` on bundle products in `productUpdateGuards.ts`.
- **Status:** Fixed (2026-11-07 — verified via TypeScript `tsc --noEmit`, 49 architecture guards & Vitest regression suites)

### [🔴 Critical] BUG-018: Stocktake queries and variance review include negative-stock `allowBackorder` items and divide variance % by signed negative `expectedQty`
- **File:** `server/services/stocktake/reviewCore.ts:505`, `server/services/stocktake/create.ts`, `server/services/stocktake/liveScope.ts`, `server/services/stocktake/queries.ts`
- **Issue:** `CLAUDE.md §6` (`يُباع بالطلب`) mandates that negative stock on `allowBackorder = true` products is a customer obligation counter and MUST NOT be zeroed or swept by stocktake. Yet stocktake session creation/scope/queries include negative `allowBackorder` rows, and `reviewCore.ts:505` divides variance percentage by `it.expectedQty` without `Math.abs`, inverting signs when `expectedQty < 0`.
- **Trigger:** Start or review a stocktake in a branch that has `allowBackorder` items with `branchStock.quantity < 0`.
- **Impact:** Risk of wiping customer backorder obligations via stocktake adjustment and inverted variance threshold math.
- **Suggested Fix:** Exclude `and(eq(products.allowBackorder, true), lt(branchStock.quantity, 0))` from stocktake scope/creation queries and use `Math.abs(it.expectedQty)` in `reviewCore.ts:505`.
- **Status:** Fixed (2026-11-07 — verified via TypeScript `tsc --noEmit`, 49 architecture guards & Vitest regression suites)

### [🔴 Critical] BUG-019: `voucherRouter` blocks `admin`/`isOwner` with `branchId == null` on voucher lifecycle mutations and strips `supplierCashSource`
- **File:** `server/routers/voucherRouter.ts:119,182,215,252,288`
- **Issue:** Global `admin`/`isOwner` accounts legitimately have `branchId: null` (`canCrossBranches`), yet `approve`, `reject`, `resubmitExpensePayment`, and `cancel` in `voucherRouter.ts` throw `FORBIDDEN` (*"لا فرع مُسنَد لهذا المستخدم"*) whenever `ctx.user.branchId == null`! In addition, `vouchers.create` omits `supplierCashSource` from its Zod input schema, silently dropping explicit cash source selection.
- **Trigger:** Log in as the system owner (`admin@alroya.local` with `branchId = null`) and attempt to approve, reject, or cancel a voucher, or create a supplier payment voucher with an explicit `supplierCashSource`.
- **Impact:** System owner/admin is locked out of voucher governance actions, and `supplierCashSource` is silently dropped.
- **Suggested Fix:** Allow `canCrossBranches(ctx.user)` (`role === "admin" || isOwner === true`) when `ctx.user.branchId == null` in `voucherRouter.ts` lifecycle procedures, and include `supplierCashSource` in `vouchers.create` Zod schema and service call.
- **Status:** Fixed (2026-11-07 — verified via TypeScript `tsc --noEmit`, 49 architecture guards & Vitest regression suites)

### [🔴 Critical] BUG-020: Google Maps & WhatsApp location sharing fails on `maps.app.goo.gl`, `!3d!4d` place pins, and Arabic numerals, and `listOnlineOrders` omits `latitude`/`longitude`
- **File:** `client/src/components/storefront/StorefrontLocationPicker.tsx:41-68`, `expo/customer-store-mobile/app/checkout.tsx:65-95`, `server/services/orderFulfillmentService.ts:224`
- **Issue:** (1) Customer-pasted `https://maps.app.goo.gl/...` links (the default Share output of Google Maps on Android/iOS) contain zero coordinates in the URL string and fail completely without server unshortening. (2) Full Google Maps place URLs contain both `@viewportLat,viewportLng` AND `!3dPinLat!4dPinLng`; matching `@lat,lng` first extracts the camera viewport center instead of the actual pinned building! (3) WhatsApp multi-line location messages, `?query=`, `ll=`, `daddr=`, `geo:`, and Arabic-Indic digits (`٣٣.٣١٥٢`) fail to parse. (4) `listOnlineOrders` (`orderFulfillmentService.ts:224`) omits `latitude` and `longitude` from its mapped return rows, so `OrderFulfillment` / `DispatchDialog` never receive the saved coordinates!
- **Trigger:** Paste a shared Google Maps mobile link or WhatsApp location in Web/Mobile checkout, or inspect an online order with coordinates in `/orders/fulfillment`.
- **Impact:** Customers cannot share their delivery pin via standard Google Maps links, and couriers/staff lose the saved coordinates on the fulfillment board.
- **Suggested Fix:** Build shared `shared/geoCoordinates.ts` prioritizing `!3d...!4d...` before `@lat,lng` and supporting all Google/Apple/WhatsApp/Arabic formats; add SSRF-hardened `storefront.resolveLocationUrl` (`redirect: "manual"`, strict Google Maps HTTPS host allowlist, max 5 hops, 4s timeout); upgrade `StorefrontLocationPicker.tsx` (with Google Maps JS API v3 `importLibrary("maps")` + `AdvancedMarkerElement` + `gmp_git_agentskills_v1` when `VITE_GOOGLE_MAPS_API_KEY` is configured) and `checkout.tsx`; and include `latitude` & `longitude` in `listOnlineOrders`.
- **Status:** Fixed (2026-11-07 — verified via TypeScript `tsc --noEmit`, 49 architecture guards & Vitest regression suites)

### [🔴 Critical] BUG-021: Delivery `consignmentBackedBalance` ignores `DELIVERED` unremitted parcels & shortfalls, and shortfall settlement omits `SHORTFALL_SETTLED` ledger entries
- **File:** `server/services/delivery/guards.ts:221-239`, `server/services/delivery/settle.ts:260,956`
- **Issue:** `consignmentBackedBalance` in `delivery/guards.ts` only sums `DISPATCHED`/`PARTIAL` `codAmount`, overlooking `DELIVERED` consignments whose cash is still unremitted (`moneyStatus` not settled) and `SHORTFALL_ASSIGNED` balances, skewing courier balance guards. Meanwhile, `settleLooseShortfallsTx` and `writeOffShortfall` in `delivery/settle.ts` settle/write off shortfall obligations without appending `SHORTFALL_SETTLED` entries to `deliveryLedgerEntries`.
- **Trigger:** Confirm delivery with a shortfall or hold unremitted `DELIVERED` COD parcels, then run courier balance check or settle/write off loose shortfalls.
- **Impact:** Drift between `deliveryParties.currentBalance`, `partyExposure`, and `deliveryLedgerEntries`.
- **Suggested Fix:** Align `consignmentBackedBalance` with live open monetary exposure (`DISPATCHED`/`PARTIAL`/`DELIVERED` unremitted + open shortfalls) after checking `delivery*.test.ts`, and append `SHORTFALL_SETTLED` ledger entries in `settleLooseShortfallsTx` and `writeOffShortfall`.
- **Status:** Fixed (2026-11-07 — verified via TypeScript `tsc --noEmit`, 49 architecture guards & Vitest regression suites)

### [🔴 Critical] BUG-022: Offline `readShiftOutboxSummary` inspects `i.payload.shiftId` on AES-GCM encrypted outbox items, always returning `0` pending items on shift close
- **File:** `client/src/lib/offline/outbox.ts:640-646`, `client/src/components/reception/ReceptionShiftCloseDialog.tsx`, `client/src/pages/Shifts.tsx`
- **Issue:** Outbox entries store `shiftId` at the top level (`i.shiftId`) while encrypting `i.payload` into `{ iv, ciphertext }`. `readShiftOutboxSummary` checks `(i.payload as { shiftId?: number })?.shiftId === shiftId`, which is ALWAYS `undefined !== shiftId` on encrypted entries, returning `pendingCount: 0`! It also adds `RETURN` amounts instead of subtracting them, and is not wired into `ReceptionShiftCloseDialog.tsx` or `Shifts.tsx`.
- **Trigger:** Record an offline cash sale during network loss, then open the Shift Close dialog before the outbox syncs.
- **Impact:** Cashiers close shifts without any warning of unsynced offline cash sales, creating guaranteed cash drawer variances once the outbox replays.
- **Suggested Fix:** Read top-level `Number(i.shiftId) === Number(shiftId)` (falling back to `i.payload?.shiftId` for legacy unencrypted test fixtures), subtract `RETURN` outbox totals from net cash impact, and display the pending-outbox warning guard in `ReceptionShiftCloseDialog.tsx` and `Shifts.tsx`.
- **Status:** Fixed (2026-11-07 — verified via TypeScript `tsc --noEmit`, 49 architecture guards & Vitest regression suites)

### [🔴 Critical] BUG-023: `expo/customer-store-mobile` cart screen injects hardcoded fake `IMPULSE_ADDONS` (`productUnitId: 9901..9904`)
- **File:** `expo/customer-store-mobile/app/(tabs)/cart.tsx:44-49,215-248`
- **Issue:** `cart.tsx` renders hardcoded impulse add-on items with fabricated IDs `productUnitId: 9901..9904`. Tapping add injects non-existent or completely unrelated database `productUnits` into the customer's real checkout payload.
- **Trigger:** Tap any impulse add-on card in the mobile customer store cart screen and submit the order.
- **Impact:** Checkout crashes with invalid unit errors or ships wrong real catalog items at wrong prices.
- **Suggested Fix:** Remove hardcoded `IMPULSE_ADDONS` from `cart.tsx` (or populate recommendations strictly from live catalog API items with verified `productUnitId`).
- **Status:** Fixed (2026-11-07 — verified via TypeScript `tsc --noEmit`, 49 architecture guards & Vitest regression suites)

### [🔴 Critical] BUG-024: `expo/superapp-mobile` fabricates fake receipt/audit numbers in local state for Shift Handover, Stock Audit, and Owner Decisions
- **File:** `expo/superapp-mobile/src/components/ShiftHandoverCard.tsx:45-78`, `expo/superapp-mobile/src/components/MobileStockAuditCard.tsx:52-89`, `expo/superapp-mobile/src/components/OwnerDecisionCenter.tsx:60-112`
- **Issue:** Submitting Shift Handover, Mobile Stock Audit, or Owner Decision cards in `superapp-mobile` runs purely local `setTimeout`/state logic that generates fake confirmation codes (`SH-...`, `AUD-...`) without calling a real transactional backend mutation!
- **Trigger:** Submit a shift handover or stock count from `superapp-mobile`.
- **Impact:** Illusion of completion (`CLAUDE.md §4` violation): staff believe cash handover or stock audit was recorded in ERP when zero database write occurred.
- **Suggested Fix:** Replace deceptive fake success generators with honest read-only status / deep-link handoff or real backend procedures, never fabricating voucher or audit numbers locally.
- **Status:** Fixed (2026-11-07 — verified via TypeScript `tsc --noEmit`, 49 architecture guards & Vitest regression suites)

### [🟡 Intermediate] BUG-025: Weekly rest days (`hours === 0`) vanish from the HR attendance statement table and scheduled hours card lacks `scheduledHoursToDate`
- **File:** `server/services/hr/attendancePay.ts:165-169`, `client/src/components/hr/statement/AttendanceStatementSummary.tsx:31-48`, `client/src/components/hr/statement/AttendanceStatementTable.tsx:168-255`, `client/src/lib/printing/printAttendanceStatement.ts`
- **Issue:** `computeAttendancePay` skips `schedHours <= 0 && !att` (`continue`), causing weekly rest days (e.g., Friday `2026-11-06` between `11-05` and `11-07`) to vanish from the chronological table and removing the `تصحيح` button needed when an employee worked manually on Friday. Meanwhile, `AttendanceStatementSummary` shows full-month `208.00` scheduled hours mid-month without `ساعات الدوام المطلوبة حتى اليوم`.
- **Trigger:** Open `/hr/employees/:id` for any employee with a weekly rest day (Friday) during or after a month.
- **Impact:** Chronological gaps in the statement table, inability to click `تصحيح` directly on a rest day row, and confusing scheduled hours comparison mid-month.
- **Suggested Fix:** Add optional `includeRestDays?: boolean` to `AttendancePayInput` (enabled in `getEmployeeStatement` when `!confirmedAttendanceOnly`) emitting `state: "restDay"` (`"استراحة أسبوعية"`) with `0` required hours and `تصحيح` button enabled; display `scheduledHoursToDate` on `AttendanceStatementSummary` for partial months with `من أصل X س للشهر` subtitle.
- **Status:** Fixed (2026-11-07 — verified via TypeScript `tsc --noEmit`, 49 architecture guards & Vitest regression suites)

### [🟡 Intermediate] BUG-026: Split-shift validation rejects midnight-crossing breaks between sessions, and `parseAttendanceDayDetails` drops `grossHours` under full late deduction
- **File:** `shared/attendanceHours.ts:165-171,347-363,541-544`
- **Issue:** When a split shift's break crosses midnight (e.g., Session 1 `20:00→23:00` and Session 2 `00:00→03:00`, as produced by `buildDefaultSplitSessions("20:00", "03:00", { crossMidnight: true })`), `dayOffsetMinutes` stays `0` because neither session individually has `outMin < inMin`, so Session 2's `absInMin` (`0`) is `< prevOutAbsMinutes` (`1380`), triggering a false `OVERLAP` violation! Also `parseAttendanceDayDetails` (`line 541`) sets `grossHours = 0` when `validStored === 0` even if `lateDeductionMinutes > 0` consumed the worked span.
- **Trigger:** Configure or record a night split shift whose inter-session break crosses `00:00`, or view a punch fully offset by late deduction.
- **Impact:** Night split-shift punches fail validation with a false overlap error.
- **Suggested Fix:** Advance `dayOffsetMinutes += 24 * 60` in `attendanceHours.ts` when `prevOutAbsMinutes != null && absInMin < prevOutAbsMinutes && prevOutMin >= 12 * 60 && inMin < 12 * 60 && dayOffsetMinutes === 0`, and recover `grossHours` from `lateDeductionMinutes / 60` when `validStored === 0 && lateDeductionMinutes > 0`.
- **Status:** Fixed (2026-11-07 — verified via TypeScript `tsc --noEmit`, 49 architecture guards & Vitest regression suites)

### [🟡 Intermediate] BUG-027: UTC vs Baghdad (`Asia/Baghdad`) date/month/year drift between `00:00–02:59` Baghdad and 100-employee cap in `Promotions.tsx`
- **File:** `shared/hr.ts:62-75`, `client/src/components/hr/statement/useEmployeeStatement.ts:34-40`, `client/src/components/hr/statement/AttendanceStatementHeader.tsx:44-50`, `client/src/pages/Attendance.tsx:96-102`, `client/src/pages/Promotions.tsx:52,135`, `server/routers/leaveRouter.ts:55,112`
- **Issue:** Multiple HR callers use `new Date().toISOString().slice(0, 7)` / `getUTCFullYear()` instead of `Asia/Baghdad` (`UTC+3`), placing `00:00–02:59` Baghdad on the previous day/month/year. Also `Promotions.tsx:135` queries `employees.list` with `limit: 100`, hiding employees beyond #100.
- **Trigger:** Use HR attendance, statement, leave balance, or promotions between midnight and 3 AM Baghdad time, or open `/hr/promotions` with >100 employees.
- **Impact:** Wrong default month/day/leave year after midnight and missing employees in promotions dropdown.
- **Suggested Fix:** Add `baghdadTodayYmd()`, `baghdadCurrentMonth()`, and `recentBaghdadMonths(count)` in `shared/hr.ts` (keeping `recentAttendanceMonths(count, now)` contract intact when `now` is passed), adopt Baghdad helpers across HR UI/leaveRouter, and raise/paginate employee loading in `Promotions.tsx`.
- **Status:** Fixed (2026-11-07 — verified via TypeScript `tsc --noEmit`, 49 architecture guards & Vitest regression suites)

### [🟡 Intermediate] BUG-028: Saving manual `ABSENT` or `LEAVE` in `AttendanceCorrectionDialog.tsx` sends stale `checkIn`/`checkOut` times
- **File:** `client/src/components/hr/statement/AttendanceCorrectionDialog.tsx:210-215`
- **Issue:** Switching a day from `PRESENT` to `ABSENT` or `LEAVE` hides the time inputs visually, but `savePayload` still submits the previous `checkIn`/`checkOut` strings in state.
- **Trigger:** Click `تصحيح` on a day that had `14:05` check-in, switch status to `غياب` (`ABSENT`) or `إجازة` (`LEAVE`), and click Save.
- **Impact:** Database row stores `status = "ABSENT"` alongside non-null `checkIn`/`checkOut` timestamps.
- **Suggested Fix:** Send `checkIn: undefined, checkOut: undefined, sessions: undefined` when `status === "ABSENT" || status === "LEAVE"` in `AttendanceCorrectionDialog.tsx`.
- **Status:** Fixed (2026-11-07 — verified via TypeScript `tsc --noEmit`, 49 architecture guards & Vitest regression suites)

### [🟡 Intermediate] BUG-029: Sidebar/Hub visibility & UX drift (`AppLayout` `/my-stocktake`, un-gated badge queries, truncated `"الرؤي..."` header, `HybridSidebarNav` duplicates, `PointOfSale`, `TreasuryHub`, `CommandPalette`)
- **File:** `client/src/components/AppLayout.tsx`, `client/src/components/HybridSidebarNav.tsx`, `client/src/pages/PointOfSale.tsx:108`, `client/src/pages/TreasuryHub.tsx:69`, `client/src/components/CommandPalette.tsx`
- **Issue:** (1) `AppLayout.tsx` injects self-service `/my-stocktake` into `navItems` before `visibleNav` strips it for roles without `products` module access, fires background badge count queries (`workOrders.readyCount`, `delivery.readyCount`) without checking `canSeeGate`, and crowds `"الرؤية العربية"` into `"الرؤي..."` in the sidebar header (visible in user screenshot). (2) `HybridSidebarNav.tsx` repeats links across `عملي` and `اختصاراتي` (visible in user screenshot: `مطلوب مني الآن` and `التقارير` duplicated) and double-highlights sibling query-param routes. (3) `PointOfSale.tsx:108` omits `operationPolicy` in `canSeeMode`. (4) `TreasuryHub.tsx:69` checks `role === "admin"` without `isOwner` / `operationPolicy`. (5) `CommandPalette.tsx` offers all `PAGES` without `canSeeGate` filtering.
- **Trigger:** Navigate the app across roles or inspect the right sidebar in `/hr/employees/43`.
- **Impact:** Duplicate sidebar items, truncated company name `"الرؤي..."`, unauthorized `403` background polling, and disappearing/reappearing tabs.
- **Suggested Fix:** Append self-service `/my-stocktake` after `visibleNav`, gate badge queries with `canSeeGate`, give `"الرؤية العربية"` clean header spacing so it never truncates to `"الرؤي..."`, deduplicate `اختصاراتي` against `عملي` + match query-param routes specifically in `HybridSidebarNav.tsx`, and wire `effectiveOperationPolicy` into `PointOfSale.tsx`, `TreasuryHub.tsx`, and `CommandPalette.tsx`.
- **Status:** Fixed (2026-11-07 — verified via TypeScript `tsc --noEmit`, 49 architecture guards & Vitest regression suites)

### [🟡 Intermediate] BUG-030: `REVERSE_DELIVERY` work order control requests lack `refundOverride` on approval and requester `withdraw`
- **File:** `server/services/workOrder/controlRequests.ts:256-258,396-401,538-547`, `client/src/components/workOrders/WorkOrderControlApprovals.tsx:354-369,422-437`
- **Issue:** `REVERSE_DELIVERY` freezes `refundShiftId` at request creation. If that shift closes before manager approval, `resolveLockedReceptionCashSource` fails with `PRECONDITION_FAILED`, yet `refundOverride` is restricted to `requestType === "CANCEL"` and there is no `withdraw` action for the requester.
- **Trigger:** Submit a cash `REVERSE_DELIVERY` request, close the reception shift, and attempt to approve as manager.
- **Impact:** Request cannot be rerouted to the newly opened shift or treasury without rejecting and recreating from scratch.
- **Suggested Fix:** Extend `refundOverride` support in `workOrder/controlRequests.ts` and `ApprovalRefundRailPicker` in `WorkOrderControlApprovals.tsx` to `REVERSE_DELIVERY`, and support requester `withdraw` on `PENDING` work order control requests.
- **Status:** Fixed (2026-11-07 — verified via TypeScript `tsc --noEmit`, 49 architecture guards & Vitest regression suites)

### [🟡 Intermediate] BUG-031: Creators of `SALES_RETURN` / `SALES_CANCEL` with `print_cashier` / `print_operator` roles cannot view or withdraw their own pending requests
- **File:** `server/routers/salesControlRouter.ts:202,301`, `client/src/pages/SalesHub.tsx:20`
- **Issue:** `returnsProcedure` allows `print_cashier` and `print_operator` (`sales:NONE`) to create `SALES_RETURN`/`SALES_CANCEL` requests (locking the invoice), but `salesControl.list` requires `sales:READ` and `salesControl.withdraw` requires `salesCorrectionProcedure` (`products:READ` + `sales:FULL || workorders:FULL`).
- **Trigger:** Submit a return request by mistake as `print_cashier` and attempt to view or withdraw it.
- **Impact:** `FORBIDDEN` error leaving the invoice locked until a manager intervenes.
- **Suggested Fix:** Allow authenticated staff with `returnsProcedure` access to list their own pending requests (`requestedBy === ctx.user.id`) and withdraw their own `PENDING` request in `salesControlRouter.ts`.
- **Status:** Fixed (2026-11-07 — verified via TypeScript `tsc --noEmit`, 49 architecture guards & Vitest regression suites)

### [🟡 Intermediate] BUG-032: `ReceptionDraftsPage.tsx` drops `?draftId=` on resume redirect, omits `shiftId` on deposit refund, and misleads on funded draft cancel
- **File:** `client/src/pages/reception/ReceptionDraftsPage.tsx:281,427,448-455,683`, `client/src/App.tsx:383-385`, `client/src/pages/Reception.tsx:116-119`
- **Issue:** Clicking «إكمال بالكاشير» navigates to `/reception?draftId=${d.id}`, which `App.tsx:383` redirects to `/pos?mode=RECEPTION` stripping `draftId`, and `Reception.tsx` never reads `draftId` from URL query params. Also `ReceptionDraftsPage` calls `draftRefundDeposit` without `shiftId` (failing when >1 shift is open) and shows misleading confirmation copy when `heldNet > 0`.
- **Trigger:** Click resume, refund deposit (with POS + Reception shifts open), or cancel a funded draft in `/reception/drafts`.
- **Impact:** Empty reception cart on resume and failed deposit refunds/cancellations.
- **Suggested Fix:** Preserve query params on `/reception` redirect in `App.tsx`, auto-load `?draftId=` in `Reception.tsx`, pass `shiftId` selector on deposit refund, and guard funded draft cancel copy/action accurately in `ReceptionDraftsPage.tsx`.
- **Status:** Fixed (2026-11-07 — verified via TypeScript `tsc --noEmit`, 49 architecture guards & Vitest regression suites)

### [🟡 Intermediate] BUG-033: `receptionRouter.draftCommit` rejects `externalPaymentAttemptId` without manual `reference`, and `workOrder/create.ts` skips non-cash reference check on split `depositPayments`
- **File:** `server/routers/receptionRouter.ts:543`, `server/services/workOrder/create.ts:535,685-769`
- **Issue:** `receptionRouter.ts:543` requires `collectNow.reference?.trim()` on non-cash commits even when `collectNow.externalPaymentAttemptId` is supplied, while `workOrder/create.ts` checks `paymentReference` on the legacy scalar field (even when `deposit === 0`) yet skips checking `leg.reference` inside split `depositPayments`.
- **Trigger:** Commit a reception draft via confirmed external payment attempt without typing a duplicate manual reference, or create a work order with split card `depositPayments` missing a reference.
- **Impact:** Valid external-attempt commits fail with `BAD_REQUEST`, while split card deposits slip through with `referenceNumber: null`.
- **Suggested Fix:** Accept `Boolean(input.collectNow.reference?.trim() || input.collectNow.externalPaymentAttemptId)` in `receptionRouter.ts:543`, and enforce non-empty `reference` on positive non-cash `depositPayments` legs (and scalar `paymentReference` only when `deposit > 0 && !hasExplicitSplit`) in `workOrder/create.ts`.
- **Status:** Fixed (2026-11-07 — verified via TypeScript `tsc --noEmit`, 49 architecture guards & Vitest regression suites)

### [🟡 Intermediate] BUG-034: Return valuation/GL/cap/float defects across `returnRouter.ts`, `refundCaps.ts`, `useSalesReturnSettlement.ts`, and `WorkOrderDetail.tsx`
- **File:** `server/routers/returnRouter.ts:2259-2426,3980-4002,4388-4393`, `server/services/returns/refundCaps.ts:306-387`, `client/src/components/returns/useSalesReturnSettlement.ts:55-111`, `client/src/pages/WorkOrderDetail.tsx:184-187,608-611`
- **Issue:** (1) `executeSalesReturnCart` fallback calls `applyMovement` instead of `applyValuedInboundMovement` and omits `CARD` reference validation; (2) legacy `returns.executeNoReceiptOrExchange` mutates inventory without GL entries or receipts; (3) batch `loadRefundCapsByInvoiceIds` omits `digitalIntentSettlements` unlike singular `loadRefundCaps`; (4) `useSalesReturnSettlement.ts` and `WorkOrderDetail.tsx` use float `Number(...)` arithmetic on money (`CLAUDE.md §5` violation).
- **Trigger:** Process returns on digital-wallet invoices in batch views, hit `0.01` float rounding drift in return settlement UI, or invoke legacy return procedures.
- **Impact:** `0.00` batch refund caps on digital settlements, `0.01` settlement mismatches, and unposted inventory/GL risk on legacy endpoints.
- **Suggested Fix:** Include `digitalIntentSettlements` in `loadRefundCapsByInvoiceIds`, use `applyValuedInboundMovement` + `CARD` reference guard in `executeSalesReturnCart`, block unposted `executeNoReceiptOrExchange`, and replace float `Number(...)` money math with `Decimal` helpers in `useSalesReturnSettlement.ts` and `WorkOrderDetail.tsx`.
- **Status:** Fixed (2026-11-07 — verified via TypeScript `tsc --noEmit`, 49 architecture guards & Vitest regression suites)

### [🟡 Intermediate] BUG-035: `PurchaseNew` / `PurchaseEdit` / `order.ts` requisition USD conversion, `costBase` unit factor, `printOrder` totals, and `requisitionAllocations` wipe
- **File:** `client/src/pages/PurchaseNew.tsx:782-797`, `client/src/pages/PurchaseEdit.tsx:147,483,648-649`, `server/services/purchase/order.ts:1325`
- **Issue:** `PurchaseNew.handleSaveRequisition` passes raw unit price without USD→IQD exchange multiplication or integer base-unit check; `PurchaseEdit` omits `/ conversionFactor` on `costBase` and miscomputes `docTotals` in `printOrder`; and `order.ts:1325` overwrites `requisitionAllocations` when `input.requisitionAllocations` is `undefined` on edit.
- **Trigger:** Save a USD purchase requisition in `PurchaseNew`, or edit/print a multi-unit purchase order in `PurchaseEdit`.
- **Impact:** Wrong IQD requisition estimates, false unit cost warnings, wrong printed PO totals, and lost requisition links on edit.
- **Suggested Fix:** Apply exchange rate & base-unit checks in `PurchaseNew.handleSaveRequisition`, divide by `conversionFactor` and pass accurate `docTotals` in `PurchaseEdit.tsx`, and preserve existing `requisitionAllocations` in `order.ts` when `input.requisitionAllocations === undefined`.
- **Status:** Fixed (2026-11-07 — verified via TypeScript `tsc --noEmit`, 49 architecture guards & Vitest regression suites)

### [🟡 Intermediate] BUG-036: `SupplierPaymentsGovernance.tsx` locks `admin`/`isOwner` with assigned `branchId` to a single branch, and `returnGovernance.ts` writes Mojibake closure notes
- **File:** `client/src/pages/SupplierPaymentsGovernance.tsx:31-39,212`, `server/services/purchase/returnGovernance.ts:556`
- **Issue:** `SupplierPaymentsGovernance.tsx` disables the branch switcher whenever `me.data?.branchId != null`, even if `me.data.role === "admin" || me.data.isOwner` (`canCrossBranches`). Separately, `returnGovernance.ts:556` contains corrupted `"??????..."` Mojibake instead of Arabic text when closing a supplier invoice settled via purchase return.
- **Trigger:** Open `/purchases/supplier-payments` as an admin/owner assigned to Branch 1, or approve a purchase return that settles an open supplier invoice.
- **Impact:** Owner cannot govern Branch 2 supplier payments without clearing their profile `branchId`, and audit/invoice notes contain `"??????"`.
- **Suggested Fix:** Allow branch switching when `me.data?.role === "admin" || Boolean(me.data?.isOwner)` in `SupplierPaymentsGovernance.tsx`, and restore clean Arabic text `"أُغلقت الفاتورة بعد تسوية التزاماتها بمرتجع شراء معتمد"` in `returnGovernance.ts:556`.
- **Status:** Fixed (2026-11-07 — verified via TypeScript `tsc --noEmit`, 49 architecture guards & Vitest regression suites)

### [🟡 Intermediate] BUG-037: `SimpleProductEditForm.tsx` leaves `allowBackorder` enabled when `isConsignment` is turned on and lacks `costChangeReason` input on blocker cost changes
- **File:** `client/src/components/products/SimpleProductEditForm.tsx:468`
- **Issue:** Enabling `isConsignment` on a product that previously had `allowBackorder = true` submits both `true`, crashing on DB `CHECK` constraint `chk_product_backorder_stocked_only` (`CLAUDE.md §6`). Also when editing cost triggers `blocker` severity on zero-stock items (`assertCostChangeReasonOrThrow`), no `costChangeReason` input is surfaced.
- **Trigger:** Toggle `بضاعة أمانة` on a backorder-enabled product or make a >25% cost correction in `SimpleProductEditForm`.
- **Impact:** Unhandled DB constraint error or blocked save with no field to enter the required reason.
- **Suggested Fix:** Automatically clear and disable `allowBackorder` when `isConsignment` (or `isService`) is enabled, and render a `costChangeReason` input in `SimpleProductEditForm` when `costPrice` changes significantly.
- **Status:** Fixed (2026-11-07 — verified via TypeScript `tsc --noEmit`, 49 architecture guards & Vitest regression suites)

### [🟡 Intermediate] BUG-038: Voucher KPI aggregation mismatch, unscoped customer invoice lookup on branch switch, and stale supplier AP message in `VoucherPartyAllocationFields`
- **File:** `server/services/voucher/queries.ts`, `client/src/components/vouchers/useVoucherFormQueries.ts`, `client/src/components/vouchers/VoucherPartyAllocationFields.tsx:194-202`
- **Issue:** `aggregateVouchers` omits joins/filters applied by `listVouchers`, causing header totals to diverge from filtered rows; `useVoucherFormQueries` does not filter customer open invoices by the selected voucher `branchId` or clear `invoiceId` when `branchId` changes; and `VoucherPartyAllocationFields.tsx` displays outdated supplier AP copy without linking directly to `/purchases/supplier-payments`.
- **Trigger:** Filter vouchers in `/vouchers`, switch branch while creating a customer receipt voucher, or select a supplier in `/vouchers/new`.
- **Impact:** Mismatched voucher KPI totals, cross-branch invoice allocation errors on submit, and confusing supplier payment UX.
- **Suggested Fix:** Align `aggregateVouchers` filters/joins with `listVouchers`, scope customer invoice query by `branchId` and reset `invoiceId` on branch change in `useVoucherFormQueries`, and update `VoucherPartyAllocationFields.tsx` guidance with a direct link to `/purchases/supplier-payments`.
- **Status:** Fixed (2026-11-07 — verified via TypeScript `tsc --noEmit`, 49 architecture guards & Vitest regression suites)

### [🟡 Intermediate] BUG-039: Online checkout idempotency fingerprint omits coordinates & customer notes, and `reviveAndConfirmOnlineOrder` skips coupon re-reservation
- **File:** `client/src/lib/storefrontPersistence.tsx:269`, `expo/customer-store-mobile/app/checkout.tsx:234`, `server/services/onlineOrderService.ts:526`, `server/services/orderFulfillmentService.ts:1915,2050`
- **Issue:** Client/server checkout replay fingerprints hash cart items, phone, and address text while omitting `latitude`, `longitude`, and `customerNotes`—so retrying after adding a map pin or note reuses the old `clientRequestId` / replay without the coordinates! Also reviving a cancelled online order that had a coupon discount restores the discounted total without re-validating/re-reserving the released coupon usage.
- **Trigger:** Submit checkout, fix/add map pin or delivery note, and re-submit within the idempotency window; or cancel and revive an online order that used a limited-use coupon.
- **Impact:** Dropped delivery coordinates/notes on order retry and coupon usage cap bypass on order revival.
- **Suggested Fix:** Include normalized `latitude`, `longitude`, and `customerNotes` in checkout fingerprints across `storefrontPersistence.tsx`, `checkout.tsx`, and `onlineOrderService.ts`, and re-reserve/validate the coupon inside `reviveAndConfirmOnlineOrder`.
- **Status:** Fixed (2026-11-07 — verified via TypeScript `tsc --noEmit`, 49 architecture guards & Vitest regression suites)

### [🟡 Intermediate] BUG-040: `OrderFulfillment.tsx` hides `CANCELLED` tab & cashier dispatch button, and `MyDeliveries.tsx` lacks pending lock / stable idempotency key
- **File:** `client/src/pages/OrderFulfillment.tsx:78-85,692`, `client/src/pages/MyDeliveries.tsx:182,331,422`
- **Issue:** `OrderFulfillment.tsx` provides no `CANCELLED` status filter tab (making `reviveAndConfirmOnlineOrder` unreachable once cancelled orders scroll off) and hides the courier dispatch action from cashiers who hold fulfillment access; meanwhile `MyDeliveries.tsx` generates a fresh `requestKey` on every tap without disabling action buttons while `transitionM.isPending`.
- **Trigger:** Try to view/revive a cancelled online order in `/orders/fulfillment`, or double-tap a delivery transition button on slow mobile data in `/my-deliveries`.
- **Impact:** Unreachable cancelled-order revival workflow and duplicate concurrent courier transition mutations.
- **Suggested Fix:** Add `"CANCELLED"` filter tab and align dispatch action visibility with fulfillment permission in `OrderFulfillment.tsx`, and keep a stable per-action `requestKey` + `disabled={transitionM.isPending}` in `MyDeliveries.tsx`.
- **Status:** Fixed (2026-11-07 — verified via TypeScript `tsc --noEmit`, 49 architecture guards & Vitest regression suites)

### [🟡 Intermediate] BUG-041: Offline router & recovery service block `isOwner === true` accounts whose base `role !== "admin"`
- **File:** `server/routers/offlineRouter.ts`, `server/services/offline/recovery.ts`
- **Issue:** Cross-branch checks in `offlineRouter.ts` and `offline/recovery.ts` test `user.role === "admin"` directly instead of `canCrossBranches(user)` (`role === "admin" || isOwner === true`).
- **Trigger:** Access cross-branch offline outbox recovery as an `isOwner: true` user with a non-admin base role.
- **Impact:** Unexpected `FORBIDDEN` error for owner accounts (`CLAUDE.md §6` `canCrossBranches` rule).
- **Suggested Fix:** Use `canCrossBranches` consistently in `offlineRouter.ts` and `offline/recovery.ts`.
- **Status:** Fixed (2026-11-07 — verified via TypeScript `tsc --noEmit`, 49 architecture guards & Vitest regression suites)

### [🟡 Intermediate] BUG-042: `expo/customer-store-mobile` checkout location modal hides feedback toast, ignores saved coordinates, and omits `Platform.OS` header
- **File:** `expo/customer-store-mobile/app/checkout.tsx`, `expo/customer-store-mobile/src/lib/storefront-api.ts:615`
- **Issue:** In `checkout.tsx`, `locationFeedback` renders behind the native `Modal` layer so users see zero feedback when pasting an invalid link, saved `@al_arabiya/delivery-location-v1` coordinates are not hydrated on mount, and `storefront-api.ts:615` calls `storefrontMutationHeaders()` without `Platform.OS`.
- **Trigger:** Paste a location link inside the mobile checkout modal or reopen checkout after saving a delivery pin.
- **Impact:** Silent location picker failures and lost saved coordinates on mobile.
- **Suggested Fix:** Render `locationFeedback` inside the `Modal` + hydrate `@al_arabiya/delivery-location-v1` + support `resolveLocationUrl` unshortening in `checkout.tsx`, and pass `Platform.OS` to `storefrontMutationHeaders(Platform.OS)` in `storefront-api.ts`.
- **Status:** Fixed (2026-11-07 — verified via TypeScript `tsc --noEmit`, 49 architecture guards & Vitest regression suites)

### [🟡 Intermediate] BUG-043: `expo/superapp-mobile` misclassifies non-expense cash outflows, branch drawer keys, and stock labels
- **File:** `expo/superapp-mobile/src/lib/operationsApi.ts`, `expo/superapp-mobile/app/(tabs)/treasury.tsx`
- **Issue:** `operationsApi.ts` / `treasury.tsx` only treat `m.source === "EXPENSE"` as outflow instead of `m.direction === "OUT"`, mismatch branch drawer keys, hardcode `branchKarradaQty` label, and use non-unique list keys.
- **Trigger:** Open the Treasury or Inventory tabs in `superapp-mobile`.
- **Impact:** Understated cash outflows and mislabeled branch inventory quantities on mobile.
- **Suggested Fix:** Classify outflows via `m.direction === "OUT" || m.source === "EXPENSE"`, align branch drawer keys and dynamic branch names, and use stable unique React keys.
- **Status:** Fixed (2026-11-07 — verified via TypeScript `tsc --noEmit`, 49 architecture guards & Vitest regression suites)

### [🟡 Intermediate] BUG-044: Printing a Z-report for an open shift in `Shifts.tsx` prints `openingBalance` instead of live `expectedCash`
- **File:** `client/src/pages/Shifts.tsx:386`
- **Issue:** `Shifts.tsx:386` passes `expectedCash: sh.expectedCash ?? sh.openingBalance` to the Z-report printer. Because `sh.expectedCash` on the DB row is `null` until the shift closes, printing a live open shift report ignores `rep.expectedCash` returned by `shifts.report` and prints `openingBalance`!
- **Trigger:** Click Print Z-Report on any currently open shift in `/shifts`.
- **Impact:** Printed mid-shift Z-report understates expected drawer cash by all sales/collections made during the shift.
- **Suggested Fix:** Pass `rep.expectedCash ?? sh.expectedCash ?? sh.openingBalance` in `Shifts.tsx:386`.
- **Status:** Fixed (2026-11-07 — verified via TypeScript `tsc --noEmit`, 49 architecture guards & Vitest regression suites)

### [🟢 Normal] BUG-045: RTL BiDi inversion on HR numbers & Arabic units (`"يوم 20"`, `"س 208.00"`, `"بلا انصراف"`, `د.ع`)
- **File:** `client/src/components/hr/statement/AttendanceStatementSummary.tsx:66-98`, `client/src/components/hr/statement/AttendanceStatementTable.tsx:188-206`, `client/src/components/hr/statement/AttendanceTimeFields.tsx:96`, `client/src/pages/EmployeeDetail.tsx:312-320`, `client/src/components/hr/EmployeeAdvanceRepaymentPanel.tsx`
- **Issue:** Wrapping mixed Latin digits and Arabic words (`"20 يوم"`, `"208.00 س"`) inside a single `dir="ltr"` container reverses the visual token order to `"يوم 20"` and `"س 208.00"` (directly visible in user's screenshot of `/hr/employees/43`), and adjacent time/currency strings suffer BiDi reordering.
- **Trigger:** View `/hr/employees/:id` in Arabic RTL.
- **Impact:** Visually inverted units and numbers across HR KPI cards, session spans, and salary/advance labels.
- **Suggested Fix:** Keep the container in RTL (`dir="rtl"`) and wrap numeric tokens individually in `<bdi dir="ltr" className="tabular-nums">...</bdi>` followed by the Arabic unit (`يوم`, `س`, `د.ع`).
- **Status:** Fixed (2026-11-07 — verified via TypeScript `tsc --noEmit`, 49 architecture guards & Vitest regression suites)

### [🟢 Normal] BUG-046: `EmployeeDetail.tsx` squeezes the 13-column statement table inside `max-w-5xl` and `EmployeeEnterpriseOperationsTab.tsx` lacks `<ScrollTableShell>`
- **File:** `client/src/pages/EmployeeDetail.tsx:246`, `client/src/components/hr/EmployeeEnterpriseOperationsTab.tsx`
- **Issue:** `EmployeeDetail.tsx` wraps the entire employee page (including the 13-column attendance statement table) in `max-w-5xl` (`1024px`), leaving wide empty margins on desktop while cramping dates (`2026-11-\n01`) and columns (directly visible in user's screenshot). Also `EmployeeEnterpriseOperationsTab.tsx` renders `<Table>` without `<ScrollTableShell>`.
- **Trigger:** Open `/hr/employees/:id` on desktop or mobile viewports.
- **Impact:** Wrapped dates, squished numeric columns, and horizontal overflow on smaller viewports.
- **Suggested Fix:** Widen `EmployeeDetail.tsx` container to `max-w-7xl` and wrap the table in `EmployeeEnterpriseOperationsTab.tsx` inside `<ScrollTableShell>`.
- **Status:** Fixed (2026-11-07 — verified via TypeScript `tsc --noEmit`, 49 architecture guards & Vitest regression suites)

### [🟢 Normal] BUG-047: Employee payslip omits `fatherName` and `grandfatherName` in header and print view
- **File:** `server/routers/payrollRouter.ts:145-160`, `client/src/pages/HrPayslip.tsx:63-64`
- **Issue:** `myPayslip` selects only `firstName` and `lastName`, displaying 2-part names instead of Iraqi 4-part names (`fullEmployeeName`) used across HR statements.
- **Trigger:** Open or print `/hr/my-payslip` for an employee with `fatherName` / `grandfatherName`.
- **Impact:** Incomplete employee legal name on printed payslips.
- **Suggested Fix:** Select `fatherName` and `grandfatherName` in `myPayslip` and format via `fullEmployeeName`.
- **Status:** Fixed (2026-11-07 — verified via TypeScript `tsc --noEmit`, 49 architecture guards & Vitest regression suites)

### [🟢 Normal] BUG-048: `RequireRole.tsx` triggers full-page reload via `<a href="/">` and displays hardcoded management-only message
- **File:** `client/src/components/RequireRole.tsx:34-46`
- **Issue:** `RequireRole` uses `<a href="/">` instead of wouter `<Link href="/">` and always says `"هذه الشاشة مخصّصة للإدارة"` even when gating courier/cashier/operator routes.
- **Trigger:** Hit a role-restricted route in SPA navigation.
- **Impact:** Full browser reload losing SPA query cache and inaccurate access-denied message.
- **Suggested Fix:** Use wouter `<Link href="/">` and neutral role-appropriate Arabic copy in `RequireRole.tsx`.
- **Status:** Fixed (2026-11-07 — verified via TypeScript `tsc --noEmit`, 49 architecture guards & Vitest regression suites)

### [🟢 Normal] BUG-049: `delivery/board.ts` stale-parcel suggestion count does not filter strictly on open unsettled consignments
- **File:** `server/services/delivery/board.ts:251`
- **Issue:** The stale parcel suggestion counter in `delivery/board.ts` checks parcel age without applying the exact same open/unsettled predicate as `assertNoStaleOpenParcelsTx`.
- **Trigger:** View the delivery board when historical consignments exist past SLA age.
- **Impact:** Banner stale parcel count can disagree with the actual SLA dispatch gate.
- **Suggested Fix:** Align `staleCount` filter in `delivery/board.ts` with `assertNoStaleOpenParcelsTx` (`DISPATCHED`/`PARTIAL` unsettled).
- **Status:** Fixed (2026-11-07 — verified via TypeScript `tsc --noEmit`, 49 architecture guards & Vitest regression suites)

### [🟢 Normal] BUG-050: `EditOnlineOrderDialog.tsx` and courier WhatsApp helper lack map coordinate paste/link support
- **File:** `client/src/components/orders/EditOnlineOrderDialog.tsx`, `client/src/lib/whatsapp.ts`, `server/routers/storeAdminRouter.ts:380-381`
- **Issue:** When customers send their Google Maps pin over WhatsApp after placing an order, staff editing the order in `EditOnlineOrderDialog` have no location link/coordinate field to attach `latitude`/`longitude`, and courier WhatsApp dispatch messages omit a clickable Google Maps URL when coordinates exist.
- **Trigger:** Edit an online order's address for a customer who sent a WhatsApp map pin, then send the order details to the courier via WhatsApp.
- **Impact:** Staff cannot attach post-checkout map pins and couriers do not receive a direct navigation link on WhatsApp.
- **Suggested Fix:** Add coordinate/link parsing + short-link resolution to `EditOnlineOrderDialog.tsx` and `storeAdminRouter.ts` (`updateOnlineOrder`), and append the `https://www.google.com/maps?q=lat,lng` link in `whatsapp.ts` when valid coordinates exist.
- **Status:** Fixed (2026-11-07 — verified via TypeScript `tsc --noEmit`, 49 architecture guards & Vitest regression suites)
