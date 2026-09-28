import { renderPaypleBridge } from "@/lib/payple-bridge-page";

export async function GET(request: Request) {
  return renderPaypleBridge(new URL(request.url));
}
