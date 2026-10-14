import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";
import {
  MODEL_COLUMNS,
  PLANT_MODELS_BUCKET,
  cleanModelScope,
  cleanModelStatus,
  formatFromFileName,
  looksLikeGlb,
  plantModelUrl,
  type PlantModel,
} from "@/lib/plantModels";

type RouteParams = { params: Promise<{ id: string }> };

const text = (v: unknown, max = 300): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim().slice(0, max);
  return t ? t : null;
};

const int = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
};

// Read the first bytes of an uploaded object and check they are really glTF.
//
// This is the step that separates "the upload returned 200" from "there is a
// model here". A signed URL will faithfully store a renamed .obj, an HTML error
// page, or the first half of an interrupted download, and every one of those
// produces a viewer that spins and then shows nothing — a failure that looks
// like a bug in the viewer rather than in the file. The bucket's mime-type
// allowlist cannot help: browsers send application/octet-stream for .glb.
//
// A Range request so a 30 MB model is not pulled into a serverless function to
// inspect twelve bytes. Returning null means "could not check", which is
// treated as acceptable rather than fatal: a storage hiccup should not throw
// away a model that uploaded fine.
async function glbHeaderCheck(path: string): Promise<{ ok: boolean; checked: boolean }> {
  const url = plantModelUrl(path);
  if (!url) return { ok: true, checked: false };
  try {
    const res = await fetch(url, { headers: { Range: "bytes=0-11" }, cache: "no-store" });
    if (!res.ok && res.status !== 206) return { ok: false, checked: true };
    const buf = await res.arrayBuffer();
    // A server that ignores Range hands back the whole file; slice so the check
    // is the same either way.
    return { ok: looksLikeGlb(buf.slice(0, 12)), checked: true };
  } catch {
    return { ok: true, checked: false };
  }
}

// Make one row the primary without ever having two. The partial unique index
// would reject the second, so the previous holder is stood down first — and
// marked 'superseded' rather than deleted, because knowing a model was once the
// one being shown is worth more than a tidy table.
async function demotePrimary(plantId: number, exceptId?: number) {
  let q = supabase
    .from("plant_models")
    .update({ status: "superseded" })
    .eq("plant_id", plantId)
    .eq("status", "primary");
  if (exceptId != null) q = q.neq("id", exceptId);
  return q;
}

// Every model kept against a plant, primary first, then newest.
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const plantId = Number(id);
  if (!Number.isInteger(plantId)) {
    return NextResponse.json({ error: "invalid plant id" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("plant_models")
    .select(MODEL_COLUMNS)
    .eq("plant_id", plantId)
    .neq("status", "rejected")
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const models = (data ?? []) as unknown as PlantModel[];
  models.sort((a, b) => (a.status === "primary" ? -1 : b.status === "primary" ? 1 : 0));

  return NextResponse.json({
    models: models.map((m) => ({ ...m, url: plantModelUrl(m.storage_path) })),
  });
}

// Register a model whose bytes are already in the bucket.
//
// The upload itself happened directly against Storage via a signed URL (see
// ./upload-url), so this call carries metadata, not a file. It verifies the
// object is really there and really glTF before writing a row — otherwise a row
// can claim a path that was never written, and the catalog would show a model
// that does not exist.
export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const plantId = Number(id);
  if (!Number.isInteger(plantId)) {
    return NextResponse.json({ error: "invalid plant id" }, { status: 400 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return NextResponse.json({ error: "a JSON body is required" }, { status: 400 });
  }

  const storagePath = text(body.storage_path, 500);
  if (!storagePath) {
    return NextResponse.json({ error: "storage_path is required" }, { status: 400 });
  }
  // The path was minted by the upload-url route under this plant's folder.
  // Re-checking the prefix here stops a row for plant A pointing at plant B's
  // object, which would make a later delete reclaim someone else's file.
  if (!storagePath.startsWith(`${plantId}/`)) {
    return NextResponse.json(
      { error: "storage_path does not belong to this plant" },
      { status: 400 },
    );
  }

  const { ok, checked } = await glbHeaderCheck(storagePath);
  if (!ok) {
    await supabase.storage.from(PLANT_MODELS_BUCKET).remove([storagePath]);
    return NextResponse.json(
      { error: "that file is not a glTF/GLB model — nothing was saved" },
      { status: 400 },
    );
  }

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

  const makePrimary = body.make_primary !== false; // the first model is the point
  if (makePrimary) {
    const { error } = await demotePrimary(plantId);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }

  const { data: row, error } = await supabase
    .from("plant_models")
    .insert({
      plant_id: plantId,
      status: makePrimary ? "primary" : "alternate",
      source: text(body.source, 60) ?? "upload",
      source_url: text(body.source_url, 500),
      credit: text(body.credit, 200),
      license: text(body.license, 120),
      // No scope claimed is left null — "nobody has said" — rather than
      // defaulted to 'cultivar', which would quietly vouch for the geometry.
      model_scope: cleanModelScope(body.model_scope),
      storage_path: storagePath,
      format: formatFromFileName(storagePath),
      bytes: int(body.bytes),
      triangles: int(body.triangles),
      height_in: int(body.height_in),
      season: text(body.season, 40),
      caption: text(body.caption),
      notes: checked ? null : "glTF header could not be verified at upload",
      reviewed_at: new Date().toISOString(),
    })
    .select(MODEL_COLUMNS)
    .maybeSingle();

  if (error || !row) {
    // Never leave an object behind a failed insert.
    await supabase.storage.from(PLANT_MODELS_BUCKET).remove([storagePath]);
    return NextResponse.json({ error: error?.message ?? "insert failed" }, { status: 500 });
  }

  const model = row as unknown as PlantModel;
  return NextResponse.json(
    { model: { ...model, url: plantModelUrl(model.storage_path) } },
    { status: 201 },
  );
}

// Promote a model, or correct what it claims to be.
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const plantId = Number(id);
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const modelId = int(body?.modelId);
  if (!Number.isInteger(plantId) || modelId == null) {
    return NextResponse.json({ error: "invalid plant or model id" }, { status: 400 });
  }

  // Scoped to this plant so a guessed id cannot reach another plant's row.
  const { data: existing, error: findErr } = await supabase
    .from("plant_models")
    .select("id,status")
    .eq("id", modelId)
    .eq("plant_id", plantId)
    .maybeSingle();
  if (findErr) {
    return NextResponse.json({ error: findErr.message }, { status: 500 });
  }
  if (!existing) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const patch: Record<string, unknown> = {};
  if ("caption" in body!) patch.caption = text(body!.caption);
  if ("credit" in body!) patch.credit = text(body!.credit, 200);
  if ("license" in body!) patch.license = text(body!.license, 120);
  if ("source_url" in body!) patch.source_url = text(body!.source_url, 500);
  if ("season" in body!) patch.season = text(body!.season, 40);
  if ("height_in" in body!) patch.height_in = int(body!.height_in);
  if ("triangles" in body!) patch.triangles = int(body!.triangles);
  if ("model_scope" in body!) patch.model_scope = cleanModelScope(body!.model_scope);

  const wantStatus = cleanModelStatus(body!.status);
  if (wantStatus === "primary") {
    const { error } = await demotePrimary(plantId, modelId);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    patch.status = "primary";
  } else if (wantStatus) {
    patch.status = wantStatus;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "nothing to change" }, { status: 400 });
  }
  patch.reviewed_at = new Date().toISOString();

  const { data: row, error } = await supabase
    .from("plant_models")
    .update(patch)
    .eq("id", modelId)
    .eq("plant_id", plantId)
    .select(MODEL_COLUMNS)
    .maybeSingle();
  if (error || !row) {
    return NextResponse.json({ error: error?.message ?? "update failed" }, { status: 500 });
  }

  const model = row as unknown as PlantModel;
  return NextResponse.json({ model: { ...model, url: plantModelUrl(model.storage_path) } });
}

// Drop a model. Anything addable from the app has to be removable from the app,
// or a mis-filed model becomes permanent.
export async function DELETE(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const plantId = Number(id);
  // Number(null) is 0 rather than NaN, so a missing modelId would otherwise
  // pass the integer check and come back as "not found" — which reads as "that
  // model is already gone" instead of "you did not say which model".
  const rawModelId = new URL(req.url).searchParams.get("modelId");
  const modelId = rawModelId === null || rawModelId.trim() === "" ? NaN : Number(rawModelId);
  if (!Number.isInteger(plantId) || !Number.isInteger(modelId)) {
    return NextResponse.json({ error: "invalid plant or model id" }, { status: 400 });
  }

  const { data: row, error: findErr } = await supabase
    .from("plant_models")
    .select("id,storage_path,status")
    .eq("id", modelId)
    .eq("plant_id", plantId)
    .maybeSingle();
  if (findErr) {
    return NextResponse.json({ error: findErr.message }, { status: 500 });
  }
  if (!row) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const { error } = await supabase
    .from("plant_models")
    .delete()
    .eq("id", modelId)
    .eq("plant_id", plantId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Only reclaim the object once nothing points at it. Two rows can legitimately
  // share a file (the same model registered against a species and a cultivar),
  // and removing it would blank the other card.
  const path = row.storage_path as string | null;
  if (path) {
    const { count } = await supabase
      .from("plant_models")
      .select("id", { count: "exact", head: true })
      .eq("storage_path", path);
    if (!count) {
      await supabase.storage.from(PLANT_MODELS_BUCKET).remove([path]);
    }
  }

  // Deleting the primary leaves the plant with models but nothing designated,
  // which would make the lookup route answer "no model" while the card shows
  // several. Promote the newest survivor instead of leaving that gap.
  if (row.status === "primary") {
    const { data: next } = await supabase
      .from("plant_models")
      .select("id")
      .eq("plant_id", plantId)
      .in("status", ["alternate", "superseded"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (next?.id) {
      await supabase.from("plant_models").update({ status: "primary" }).eq("id", next.id);
    }
  }

  return NextResponse.json({ ok: true });
}
