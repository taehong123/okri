import { env } from "cloudflare:workers";
import { exportOptions, exportState } from "@/lib/sites-state-export";

export function OPTIONS(request: Request) {
  return exportOptions(request);
}

export function POST(request: Request) {
  return exportState(request, env);
}
