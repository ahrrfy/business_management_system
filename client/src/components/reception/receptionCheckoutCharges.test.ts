import {describe,it,expect} from "vitest";
import {tenderFingerprint,tenderProblem,tenderPayments,type TenderPart} from "@/components/payments/splitTender";
import {buildChargeOnlyTender} from "@/components/pos/checkoutExtraAmounts";
describe("Reception whole checkout proof contract",()=>{
  it("confirms 53k card while keeping the original goods-only tender 50k",()=>{
    const part:TenderPart={id:"bank",method:"CARD",amount:"50000",reference:"BANK-1",proof:null};
    part.proof={attemptId:1,requestId:"bank-key",deviceId:"terminal",fingerprint:tenderFingerprint(1,"RECEPTION",part,"3000"),confirmed:true};
    expect(part.proof.fingerprint).toContain("53000.00");
    expect(tenderProblem([part],"50000",1,"RECEPTION","3000")).toBeNull();
    expect(tenderPayments([part])[0]).toMatchObject({method:"CARD",amount:"50000.00",externalPaymentAttemptId:1});
    expect(tenderProblem([part],"50000",1,"RECEPTION","4000")).not.toBeNull();
  });
  it("charge-only split keeps genuine CARD and CASH and one cash change",()=>{
    expect(buildChargeOnlyTender({serviceCharges:[{description:"Service",amount:"3000"}]},[{method:"CARD",amount:"1500",externalPaymentAttemptId:1},{method:"CASH",amount:"2000"}])).toMatchObject({payments:[{method:"CARD",amount:"0.00",externalPaymentAttemptId:1},{method:"CASH",amount:"500.00"}],chargePayments:[{paymentIndex:0,amount:"1500.00"},{paymentIndex:1,amount:"1500.00"}]});
  });
});
