import { describe, expect, it } from "vitest";
import { deliveryDriverOptions, requiresDeliveryDriver } from "./driverOptions";
const party = {partyType:"INDIVIDUAL",name:"carrier",userId:7,drivers:[],hasActiveDriverMembership:false,linkedUserDriverEligible:true,linkedUserBranchId:3,linkedUserName:"driver"};
describe("physical dispatch driver choices",()=>{
  it("offers an eligible linked primary in the actual branch without choosing it",()=>{
    expect(deliveryDriverOptions(party,3).map(driver=>driver.userId)).toEqual([7]);
    expect(deliveryDriverOptions(party,4)).toEqual([]);
    expect(requiresDeliveryDriver(party)).toBe(true);
  });
  it("never downgrades a disabled or out-of-branch internal carrier to external",()=>{
    expect(deliveryDriverOptions({...party,linkedUserDriverEligible:false},3)).toEqual([]);
    expect(requiresDeliveryDriver({...party,userId:null,hasActiveDriverMembership:true})).toBe(true);
    expect(requiresDeliveryDriver({...party,userId:null,hasActiveDriverMembership:false})).toBe(false);
  });
  it("deduplicates the primary and removes other branches",()=>{
    expect(deliveryDriverOptions({...party,drivers:[{userId:7,name:"same",branchId:3},{userId:8,name:"other",branchId:4}]},3)).toEqual([{userId:7,name:"same",branchId:3}]);
  });
});
