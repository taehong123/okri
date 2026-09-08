import * as domain from "@/app/api/routine-completions/route";
import { mobileV1 } from "@/lib/mobile/v1-adapter";
export const PUT = mobileV1("routine-completions", domain.PUT);
