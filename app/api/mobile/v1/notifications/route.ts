import * as domain from "@/app/api/notifications/route";
import { mobileV1 } from "@/lib/mobile/v1-adapter";
export const GET = mobileV1("notifications", domain.GET);
export const PATCH = mobileV1("notifications", domain.PATCH);
