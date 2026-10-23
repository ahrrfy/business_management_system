import { router } from "../trpc";
import { fulfillmentRequestsRouter } from "./fulfillmentRequestsRouter";
import { fulfillmentChargesRouter } from "./fulfillmentChargesRouter";
import { fulfillmentAftercareRouter } from "./fulfillmentAftercareRouter";

/** Operational preparation and aftercare keep their claims and source documents distinct. */
export const fulfillmentRouter = router({
  requests: fulfillmentRequestsRouter,
  charges: fulfillmentChargesRouter,
  aftercare: fulfillmentAftercareRouter,
});
