import coordinated, {
  CreditWriter as OriginalWriter,
} from "../credit/coordinated-worker";
import { namespaceEnvironment } from "./namespace";
export class CreditWriter extends OriginalWriter {
  protected environment(_request: Request) {
    return namespaceEnvironment(this.env);
  }
}
export default {
  fetch(request: Request, env: any, ctx: any) {
    return coordinated.fetch(request, namespaceEnvironment(env));
  },
};
