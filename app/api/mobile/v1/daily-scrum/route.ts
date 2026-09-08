import * as domain from "@/app/api/daily-scrum/route";
import { mobileV1 } from "@/lib/mobile/v1-adapter";
export const GET = mobileV1("daily-scrum", domain.GET);
export const PUT = mobileV1("daily-scrum", domain.PUT);
