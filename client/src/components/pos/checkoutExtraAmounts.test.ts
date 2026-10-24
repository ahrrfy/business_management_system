import {describe,expect,it} from "vitest";
import {buildChargeOnlyTender,clearedChargeOnlyTender,checkoutGoodsTenderAmount,checkoutExtraPayload} from "./checkoutExtraAmounts";
const service={serviceCharges:[{description:"تغليف",amount:"3000"}]};
describe("charge-only actual tender mapping",()=>{
  it("completed POS charge-only split removes consumed proof legs before the next checkout",()=>{
    const tab={paymentLegs:[{method:"CARD",externalPayment:{attemptId:81,state:"CONFIRMED"}}],payInput:"3000",paymentRef:"BANK-81",externalPayment:{attemptId:81,state:"CONFIRMED"}};
    expect({...tab,...clearedChargeOnlyTender("POS")}).toEqual({paymentLegs:[],payInput:"",paymentRef:"",externalPayment:null});
  });
  it("completed PRINT_POS charge-only split leaves split mode and removes consumed proof legs",()=>{
    const tab={splitMode:true,splitLegs:[{method:"CARD",externalPayment:{attemptId:81,state:"CONFIRMED"}}],payInput:"3000",paymentRef:"BANK-81",externalPayment:{attemptId:81,state:"CONFIRMED"}};
    expect({...tab,...clearedChargeOnlyTender("PRINT_POS")}).toEqual({splitMode:false,splitLegs:[],payInput:"",paymentRef:"",externalPayment:null});
  });
  it("COD with zero goods collected keeps an explicit zero leg and the full separate service allocation",()=>{
    const payload={...checkoutExtraPayload(service),payment:{method:"CASH",amount:checkoutGoodsTenderAmount({extraCharges:service,method:"CASH",paidAmount:"0",codMode:true,fallbackAmount:"50000.00"})}};
    expect(payload.payment).toEqual({method:"CASH",amount:"0.00"});
    expect(payload.chargePayments).toEqual([{paymentIndex:0,amount:"3000.00"}]);
    expect(payload.serviceCharges).toEqual(service.serviceCharges);
  });
  it("preserves explicit COD part-payment and ordinary cash full-payment defaults",()=>{
    const input={extraCharges:service,method:"CASH",paidAmount:"0",codMode:true,fallbackAmount:"50000.00"};
    expect(checkoutGoodsTenderAmount({...input,paidAmount:"2000"})).toBe("2000.00");
    expect(checkoutGoodsTenderAmount({...input,codMode:false})).toBe("50000.00");
  });
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
