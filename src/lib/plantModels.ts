// The 3D models kept against a plant (public.plant_models), and the rules for
// reading them back. A photograph answers "what does this plant look like"; a
// model answers "what does it look like from the angle I need", which is the
// question a rendering asks and a photograph cannot be re-shot to answer.

export const PLANT_MODELS_BUCKET = "plant-models";

// Only glTF. The catalog has one consumer that must work with no conversion
// step (a browser) and one that imports anything (Blender), so the format is
// chosen for the fussier of the two. GLB is self-contained — geometry and
// textures in one file — which is what makes a bucket of bare objects usable
// without a manifest describing which .jpg belongs to which .obj.
export const MODEL_FORMATS = ["glb", "gltf"] as const;
export type ModelFormat = (typeof MODEL_FORMATS)[number];

export const MODEL_STATUSES = [
  "primary",
  "alternate",
  "candidate",
  "rejected",
  "superseded",
] as const;
export type ModelStatus = (typeof MODEL_STATUSES)[number];

export const MODEL_SCOPES = [
  "cultivar",
  "species",
  "genus",
  "generic",
  "generated",
  "unknown",
] as const;
export type ModelScope = (typeof MODEL_SCOPES)[number];

export const MODEL_SEASONS = ["summer", "fall", "winter", "bloom"] as const;

// ---------------------------------------------------------------------------
// The URL rule — deliberately the opposite of plantImageUrl()
// ---------------------------------------------------------------------------

// `plantImageUrl()` throws away everything before the last slash and rebuilds
// the path, which is why `plant-images` has to stay flat: a photograph in a
// subfolder 404s and the card falls back to a placeholder with nothing in the
// database looking wrong. That cost a day once.
//
// This builder does NOT do that. It uses `storage_path` verbatim, so
// `plant-models` is foldered by plant id and stays browsable — you can open the
// bucket and see which plants have models. The two rules coexisting is a choice,
// not an oversight (the hardscape catalog runs the same pair), but it means the
// two functions are not interchangeable: hand a model path to plantImageUrl()
// and the folder silently disappears.
export function plantModelUrl(storagePath: string | null | undefined): string | null {
  if (!storagePath) return null;
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const path = storagePath.trim().replace(/^\/+/, "");
  if (!path) return null;
  // Encode each segment but keep the separators — encodeURIComponent would
  // turn the slashes into %2F and address an object that does not exist.
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `${base}/storage/v1/object/public/${PLANT_MODELS_BUCKET}/${encoded}`;
}

// Where a plant's model goes. Foldered by id so the bucket can be read by a
// human, and timestamped so uploading a replacement never overwrites the file a
// row still points at — the old row is deleted explicitly or not at all.
export function modelStoragePath(plantId: number, fileName: string): string {
  const ext = /\.gltf$/i.test(fileName) ? "gltf" : "glb";
  return `${plantId}/model-${Date.now()}.${ext}`;
}

export function formatFromFileName(fileName: string): ModelFormat {
  return /\.gltf$/i.test(fileName) ? "gltf" : "glb";
}

// ---------------------------------------------------------------------------
// Honesty about what the geometry is
// ---------------------------------------------------------------------------

// The photograph side of this catalog learned the hard way that a stand-in has
// to announce itself: one `Rosa.jpeg` stood in for twenty-three roses and the
// harm was the silence, not the substitution. Models are worse, because a model
// looks authoritative — it has volume and it casts a shadow — so a generated
// shrub standing in for a named cultivar can walk into a client presentation
// without anyone asking where it came from.
//
// Unlike `standInLabel()`, this does not go quiet on an unnamed species row:
// `generated` and `generic` are claims about *provenance*, true of a species
// row as much as a cultivar one. A species row showing a species-scoped model
// is the only honest silence here.
export function modelStandInLabel(
  scope: ModelScope | null | undefined,
  cultivar: string | null | undefined,
): { short: string; full: string } | null {
  if (scope === "generated") {
    return {
      short: "generated",
      full: "This model was generated, not measured. Its habit and proportions are plausible for the name, not observed on the plant.",
    };
  }
  if (scope === "generic") {
    return {
      short: "generic model",
      full: "A generic form standing in at roughly the right size — useful for massing, not for identifying the plant.",
    };
  }
  if (!scope || scope === "cultivar") return null;
  // Taxonomic stand-ins only matter once the row names something narrower.
  if (!cultivar || !cultivar.trim()) {
    return scope === "genus"
      ? { short: "genus model", full: "This is a model of the genus, not of this species." }
      : null;
  }
  if (scope === "species") {
    return { short: "species model", full: "This is a model of the species, not of this cultivar." };
  }
  if (scope === "genus") {
    return { short: "genus model", full: "This is a model of the genus, not of this cultivar." };
  }
  return { short: "unverified", full: "Nobody has checked whether this model is this cultivar." };
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export interface PlantModel {
  id: number;
  plant_id: number;
  status: ModelStatus;
  source: string;
  source_url: string | null;
  credit: string | null;
  license: string | null;
  model_scope: ModelScope | null;
  storage_path: string;
  format: ModelFormat;
  bytes: number | null;
  triangles: number | null;
  height_in: number | null;
  season: string | null;
  caption: string | null;
  notes: string | null;
  created_at: string | null;
  reviewed_at: string | null;
}

// The columns a route reads back. Spelled once so the list route, the upload
// route and the patch route cannot return differently shaped rows.
export const MODEL_COLUMNS =
  "id,plant_id,status,source,source_url,credit,license,model_scope,storage_path,format,bytes,triangles,height_in,season,caption,notes,created_at,reviewed_at";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// The table has check constraints on status/format/model_scope, so an
// unrecognised string would surface as a 500 rather than a no-op. Whitelist on
// the way in and a bad value becomes "no claim" instead of an error page — the
// same bargain cleanImageScope() makes for photographs.
export function cleanModelScope(v: unknown): ModelScope | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return (MODEL_SCOPES as readonly string[]).includes(t) ? (t as ModelScope) : null;
}

export function cleanModelStatus(v: unknown): ModelStatus | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return (MODEL_STATUSES as readonly string[]).includes(t) ? (t as ModelStatus) : null;
}

// A GLB begins with the 12-byte header `glTF` + version + total length. Checking
// it costs nothing and catches the whole class of "the upload worked but the
// viewer is blank": a renamed .obj, an HTML error page saved as .glb, a
// half-finished download. The bucket's allowed_mime_types cannot do this —
// browsers routinely send application/octet-stream for a .glb.
export const GLB_MAGIC = 0x46546c67; // 'glTF' little-endian

export function looksLikeGlb(head: ArrayBuffer): boolean {
  if (head.byteLength < 12) return false;
  const view = new DataView(head);
  if (view.getUint32(0, true) !== GLB_MAGIC) return false;
  const version = view.getUint32(4, true);
  return version === 1 || version === 2;
}

// A .gltf is JSON, so the only cheap structural check is that it parses and
// declares an asset version. Textures it references by relative URL will not
// resolve from the bucket, which is why GLB is the format the upload UI pushes.
export function looksLikeGltfJson(text: string): boolean {
  try {
    const doc = JSON.parse(text) as { asset?: { version?: unknown } };
    return !!doc && typeof doc === "object" && !!doc.asset;
  } catch {
    return false;
  }
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
