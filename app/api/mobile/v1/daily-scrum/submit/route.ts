import * as domain from "@/app/api/daily-scrum/submit/route";
import { mobileV1 } from "@/lib/mobile/v1-adapter";
export const POST = mobileV1("daily-scrum/submit", domain.POST);
