import * as domain from "@/app/api/notifications/preferences/route";
import { mobileV1 } from "@/lib/mobile/v1-adapter";
export const GET = mobileV1("notifications/preferences", domain.GET);
export const PATCH = mobileV1("notifications/preferences", domain.PATCH);
