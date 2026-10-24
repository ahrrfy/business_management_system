import {describe,expect,it} from "vitest";
import {operationalCapsSchema,resolveOperationalCaps} from "../atomicPermissions";
describe("delegated SERVICE cap",()=>{
  it.each(["admin","manager","cashier","retail_cashier","print_cashier","reception_clerk"])("%s requires explicit delegation by default",role=>{
    expect(resolveOperationalCaps(role).maxServiceChargeAmountIqd).toBe("0.00");
  });
  it("uses current user override before role cap and never converts null to unlimited",()=>{
    expect(resolveOperationalCaps("cashier",{maxServiceChargeAmountIqd:"5000"},{maxServiceChargeAmountIqd:"3000"}).maxServiceChargeAmountIqd).toBe("3000");
    expect(resolveOperationalCaps("cashier",{maxServiceChargeAmountIqd:"5000"},{maxServiceChargeAmountIqd:null}).maxServiceChargeAmountIqd).toBeNull();
    expect(resolveOperationalCaps("custom",{maxServiceChargeAmountIqd:"5000"},null,"cashier").maxServiceChargeAmountIqd).toBe("5000");
  });
  it("validates exact money precision",()=>{
    expect(operationalCapsSchema.safeParse({maxServiceChargeAmountIqd:"0"}).success).toBe(true);
    expect(operationalCapsSchema.safeParse({maxServiceChargeAmountIqd:"3000.01"}).success).toBe(true);
    expect(operationalCapsSchema.safeParse({maxServiceChargeAmountIqd:"3000.001"}).success).toBe(false);
    expect(operationalCapsSchema.safeParse({maxServiceChargeAmountIqd:"-1"}).success).toBe(false);
  });
});
