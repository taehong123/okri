import * as domain from "@/app/api/workspaces/route";
import { mobileV1 } from "@/lib/mobile/v1-adapter";
export const PATCH = mobileV1("workspaces", domain.PATCH);
