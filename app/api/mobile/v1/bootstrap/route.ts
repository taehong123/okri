import * as domain from "@/app/api/bootstrap/route";
import { mobileV1 } from "@/lib/mobile/v1-adapter";
export const GET = mobileV1("bootstrap", domain.GET);
