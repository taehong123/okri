import * as domain from "@/app/api/routines/route";
import { mobileV1 } from "@/lib/mobile/v1-adapter";
export const POST = mobileV1("routines", domain.POST);
export const PATCH = mobileV1("routines", domain.PATCH);
