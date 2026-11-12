import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";
import { safeExtension } from "@/lib/storagePaths";
import { PP_LIBRARY_BUCKET, isLibraryKind } from "@/lib/design/library";

// A symbol image can be bigger than a serverless body allows.
//
// Vercel rejects request bodies over ~4.5MB before a route runs, so a 5-7MB
// PNG posted through POST /api/design/library fails as an opaque 413. Here the
// server mints a short-lived signed upload URL for a path *it* chooses, the
// browser PUTs the bytes straight to Storage, and POST /api/design/library
// (JSON body) then registers the row. The path follows the same
// `${kind}/${id}.${ext}` layout as the multipart route.
const IMAGE_EXTS = new Set(["png", "webp", "jpg", "jpeg"]);
const ID_PATTERN = /^(plan|custom)-[0-9a-f-]{36}$/;

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    id?: unknown;
    kind?: unknown;
    fileName?: unknown;
  };

  if (typeof body.id !== "string" || !ID_PATTERN.test(body.id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  if (typeof body.kind !== "string" || !isLibraryKind(body.kind)) {
    return NextResponse.json({ error: "kind must be perspective-stamp or plan-symbol" }, { status: 400 });
  }
  const ext = safeExtension(typeof body.fileName === "string" ? body.fileName : "", "png");
  if (!IMAGE_EXTS.has(ext)) {
    return NextResponse.json({ error: "only PNG, WebP or JPEG images can be stored" }, { status: 400 });
  }

  const path = `${body.kind}/${body.id}.${ext}`;
  const { data, error } = await supabase.storage
    .from(PP_LIBRARY_BUCKET)
    .createSignedUploadUrl(path, { upsert: true });
  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? "could not create an upload URL" }, { status: 500 });
  }

  return NextResponse.json({ path: data.path, token: data.token });
}
