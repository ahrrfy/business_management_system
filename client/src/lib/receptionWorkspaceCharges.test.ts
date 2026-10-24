import {describe,it,expect} from "vitest";
import {createReceptionLocalSnapshot,parseReceptionWorkspaceSnapshot,serializeReceptionWorkspaceSnapshot,type ReceptionLocalWorkspaceInput} from "./receptionWorkspaceState";
const now=Date.now();
function input():ReceptionLocalWorkspaceInput{return {clientRequestId:"550e8400-e29b-41d4-a716-446655440000",cart:[],customer:{customerId:null,name:"",phone:null,isNew:false},phoneInput:"",customerCreditLimit:"",tierOverride:null,effectiveTier:"RETAIL",draftPromotionPending:false,draftPromotionShiftId:null,detachedRecoveryPending:false,payInput:"",method:"CARD",deferred:false,invoiceDiscountPct:"",couponInput:"",couponCode:null,couponLabel:null,channel:"WALK_IN",channelHandle:"",linkedConversationId:null};}
describe("Reception local charge intent decoder",()=>{
  it("keeps legacy snapshots and an extra-only local basket with the same recovery key",()=>{
    const legacy=createReceptionLocalSnapshot(input(),now);expect(parseReceptionWorkspaceSnapshot(serializeReceptionWorkspaceSnapshot(legacy),now)).not.toBeNull();
    const next=createReceptionLocalSnapshot({...input(),checkoutCharges:{serviceCharges:[{description:"تغليف",amount:"3000"}],approvedChargeAllocations:[]}},now);
    expect(parseReceptionWorkspaceSnapshot(serializeReceptionWorkspaceSnapshot(next),now)).toMatchObject({clientRequestId:input().clientRequestId,cart:[],checkoutCharges:{serviceCharges:[{description:"تغليف",amount:"3000"}]}});
  });
  it.each(["externalPaymentAttemptId","providerSecret","externalCost"])("rejects %s in extra intent without loosening the strict decoder",key=>{
    const snapshot=createReceptionLocalSnapshot(input(),now);
    const unsafe={...snapshot,checkoutCharges:{serviceCharges:[{description:"Service",amount:"3000",[key]:"invented"}],approvedChargeAllocations:[]}};
    expect(parseReceptionWorkspaceSnapshot(JSON.stringify(unsafe),now)).toBeNull();
  });
});
