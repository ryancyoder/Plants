import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";
import { PLANT_MODELS_BUCKET, modelStoragePath } from "@/lib/plantModels";

type RouteParams = { params: Promise<{ id: string }> };

// A model does not fit through the app.
//
// Photographs reach the server as multipart form data because compressImage()
// has already squeezed them to a couple of hundred kilobytes. A GLB cannot be
// treated that way — the textures *are* the model — and a plant that renders
// well is routinely 5–30 MB. A serverless route body caps out around 4.5 MB on
// Vercel, so pushing the file through this app would fail on exactly the models
// worth having, and fail as an opaque 413 rather than a message.
//
// So the file never touches the app. The server mints a short-lived signed
// upload URL for a path *it* chooses, the browser PUTs the bytes straight to
// Supabase Storage, and a second call registers the row. The service-role key
// stays on the server; the token authorises one object and nothing else.
export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const plantId = Number(id);
  if (!Number.isInteger(plantId)) {
    return NextResponse.json({ error: "invalid plant id" }, { status: 400 });
  }

  const body = (await req.json().catch(() => ({}))) as { fileName?: unknown };
  const fileName = typeof body.fileName === "string" ? body.fileName : "model.glb";
  if (!/\.(glb|gltf)$/i.test(fileName)) {
    return NextResponse.json(
      { error: "only .glb or .gltf files can be stored as models" },
      { status: 400 },
    );
  }

  // The plant has to exist before we hand out a writable URL, or a typo in the
  // id leaves an orphan object in the bucket that no row will ever claim.
  const { data: plant, error: plantErr } = await supabase
    .from("plants")
    .select("id")
    .eq("id", plantId)
    .maybeSingle();
  if (plantErr) {
    return NextResponse.json({ error: plantErr.message }, { status: 500 });
  }
  if (!plant) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // The client does not get to choose the path. If it did, a crafted path could
  // write into another plant's folder, or outside the id layout entirely, and
  // the bucket would stop being readable by eye.
  const path = modelStoragePath(plantId, fileName);

  const { data, error } = await supabase.storage
    .from(PLANT_MODELS_BUCKET)
    .createSignedUploadUrl(path);
  if (error || !data) {
    return NextResponse.json(
      { error: error?.message ?? "could not create an upload URL" },
      { status: 500 },
    );
  }

  return NextResponse.json({
    path: data.path,
    token: data.token,
    signedUrl: data.signedUrl,
    bucket: PLANT_MODELS_BUCKET,
  });
}
