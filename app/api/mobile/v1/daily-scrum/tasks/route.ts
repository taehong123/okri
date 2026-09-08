import * as domain from "@/app/api/daily-scrum/tasks/route";
import { mobileV1 } from "@/lib/mobile/v1-adapter";
export const POST = mobileV1("daily-scrum/tasks", domain.POST);
