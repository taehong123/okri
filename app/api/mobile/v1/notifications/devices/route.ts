import * as domain from "@/app/api/notifications/devices/route";
import { mobileV1 } from "@/lib/mobile/v1-adapter";
export const POST = mobileV1("notifications/devices", domain.POST);
export const DELETE = mobileV1("notifications/devices", domain.DELETE);
