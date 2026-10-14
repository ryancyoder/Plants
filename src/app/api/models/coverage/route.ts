import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";

// Which plants have a model, as a flat list of ids.
//
// Models will arrive a few at a time over a long while, so the question "where
// have I got to" is asked far more often than any single model is viewed. One
// request answers it for the whole catalog, which is why this is not a column on
// /api/plants: that route is paged, and a per-card lookup would be 48 requests
// to draw one screen.
//
// Only `primary` counts. An alternate is a second angle on a plant that is
// already covered, and counting it would overstate coverage — the number is only
// useful if it means "this plant can be rendered".
export async function GET() {
  const { data, error } = await supabase
    .from("plant_models")
    .select("plant_id")
    .eq("status", "primary");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const ids = Array.from(new Set((data ?? []).map((r) => Number(r.plant_id))));
  return NextResponse.json({ plant_ids: ids, count: ids.length });
}
