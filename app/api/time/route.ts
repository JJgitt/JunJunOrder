import { serverClock } from "@/lib/server-time";

export const dynamic = "force-dynamic";
export function GET() {
  return Response.json(serverClock(), { headers: { "cache-control": "no-store" } });
}
