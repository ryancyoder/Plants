import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";
import {
  PLANT_MODELS_BUCKET,
  looksLikePng,
  plantModelPosterUrl,
  posterStoragePath,
} from "@/lib/plantModels";

type RouteParams = { params: Promise<{ id: string }> };

// A thumbnail is small enough to post through the app, unlike the model.
//
// The GLB has to bypass this app entirely — 5-30 MB against a ~4.5 MB
// serverless body cap — which is why ./upload-url exists. A 512px PNG still is
// a couple of hundred kilobytes, so it takes the ordinary route a photograph
// takes: multipart in, straight to Storage, nothing to register afterwards
// because the path is derived from the model's own.
//
// Two producers, one path. The browser captures a still from <model-viewer>
// right after an upload (see modelPoster.ts), and scripts/push-poster.mjs
// pushes a Blender render from the workstation. Neither needs to know about the
// other, and re-posting simply replaces the image.
//
// One piece of configuration this depends on: the `plant-models` bucket keeps
// an allowed_mime_types list, and it was created knowing only about glTF. It
// now also carries `image/png`, without which every poster upload is refused
// 415 and every tile falls back to an icon — a failure that looks like the
// capture is broken rather than the bucket.
const MAX_BYTES = 2 * 1024 * 1024;

export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const plantId = Number(id);
  if (!Number.isInteger(plantId)) {
    return NextResponse.json({ error: "invalid plant id" }, { status: 400 });
  }

  const form = await req.formData().catch(() => null);
  if (!form) {
    return NextResponse.json({ error: "a multipart body is required" }, { status: 400 });
  }
  const file = form.get("file");
  // Number(null) is 0, which is a plausible-looking id that matches nothing, so
  // an absent field has to be caught before it reaches the integer check.
  const rawModelId = form.get("modelId");
  const modelId =
    typeof rawModelId === "string" && rawModelId.trim() !== "" ? Number(rawModelId) : NaN;

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "no image was sent" }, { status: 400 });
  }
  if (!Number.isInteger(modelId)) {
    return NextResponse.json({ error: "modelId is required" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: "that thumbnail is too big — 2 MB is plenty for a tile" },
      { status: 400 },
    );
  }

  const head = await file.slice(0, 8).arrayBuffer();
  if (!looksLikePng(head)) {
    return NextResponse.json({ error: "the thumbnail must be a PNG" }, { status: 400 });
  }

  // Scoped to the plant in the URL so a guessed model id cannot write a
  // thumbnail into another plant's folder.
  const { data: model, error: findErr } = await supabase
    .from("plant_models")
    .select("id,storage_path")
    .eq("id", modelId)
    .eq("plant_id", plantId)
    .maybeSingle();
  if (findErr) {
    return NextResponse.json({ error: findErr.message }, { status: 500 });
  }
  if (!model) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const path = posterStoragePath(model.storage_path as string);
  const { error: upErr } = await supabase.storage
    .from(PLANT_MODELS_BUCKET)
    .upload(path, file, { contentType: "image/png", upsert: true });
  if (upErr) {
    return NextResponse.json({ error: upErr.message }, { status: 500 });
  }

  return NextResponse.json({ path, posterUrl: plantModelPosterUrl(model.storage_path as string) });
}
