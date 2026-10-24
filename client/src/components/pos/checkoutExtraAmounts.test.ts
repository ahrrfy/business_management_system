import {describe,expect,it} from "vitest";
import {buildChargeOnlyTender} from "./checkoutExtraAmounts";
const service={serviceCharges:[{description:"تغليف",amount:"3000"}]};
describe("charge-only actual tender mapping",()=>{
  it("keeps CARD and CASH independently and returns cash change once",()=>{
    const result=buildChargeOnlyTender(service,[{method:"CARD",amount:"1500",externalPaymentAttemptId:81,externalPaymentDeviceId:"TERMINAL"},{method:"CASH",amount:"2000"}]);
    expect(result.payments).toEqual([{method:"CARD",amount:"0.00",externalPaymentAttemptId:81,externalPaymentDeviceId:"TERMINAL"},{method:"CASH",amount:"500.00"}]);
    expect(result.chargePayments).toEqual([{paymentIndex:0,amount:"1500.00"},{paymentIndex:1,amount:"1500.00"}]);
  });
  it("never turns an underpaid service into a fully paid cash receipt",()=>{
    expect(()=>buildChargeOnlyTender(service,[{method:"CASH",amount:"1000"}])).toThrow(/كاملة/);
  });
  it("never returns noncash overpayment as cash",()=>{
    expect(()=>buildChargeOnlyTender(service,[{method:"CARD",amount:"4000",externalPaymentAttemptId:81}])).toThrow(/غير النقدي/);
  });
  it("keeps two actual bank operations rather than inventing a drawer leg",()=>{
    const result=buildChargeOnlyTender(service,[{method:"CARD",amount:"1000",externalPaymentAttemptId:81},{method:"TRANSFER",amount:"2000",externalPaymentAttemptId:82}]);
    expect(result.payments.map(row=>row.method)).toEqual(["CARD","TRANSFER"]);
    expect(result.chargePayments.map(row=>row.amount)).toEqual(["1000.00","2000.00"]);
  });
});
