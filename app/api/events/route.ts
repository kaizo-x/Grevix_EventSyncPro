import { NextResponse } from "next/server";
import { getStore } from "@/lib/serverStore";

/** GET /api/events — returns the current event catalogue. */
export async function GET() {
  const store = getStore();
  return NextResponse.json(
    { events: store.events },
    { headers: { "Cache-Control": "no-store" } },
  );
}
