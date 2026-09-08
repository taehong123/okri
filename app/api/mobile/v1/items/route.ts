import * as domain from "@/app/api/items/route";
import { mobileV1 } from "@/lib/mobile/v1-adapter";
export const POST = mobileV1("items", domain.POST);
export const PATCH = mobileV1("items", domain.PATCH);
