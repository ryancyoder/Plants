import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";
import {
  MODEL_COLUMNS,
  plantModelPosterUrl,
  plantModelUrl,
  type PlantModel,
} from "@/lib/plantModels";

// Every 3D model worth showing inside one genus+species album.
//
// The sibling of /api/design/library/for-species, and it exists for the same
// reason: an album is a group of plants, so the question "what models does this
// album have" cannot be answered by the per-plant route the cards already use
// without one request per cultivar.
//
// Two kinds of row come back, and the distinction is the point:
//
//  - models **of** a plant in this album, and
//  - genus-wide **stand-ins** living on a plant in another album of the same
//    genus.
//
// The second kind is what makes this route more than a filter. A genus-scoped
// model is deliberately the answer for every plant in the genus — that is what
// /api/models/lookup does when it walks past cultivar and species — so hiding
// it from an album whose plants would render with it would misreport the
// catalog's own coverage. The perennial Hibiscus album is exactly this case:
// its cultivars carry no species, so they group away from `Hibiscus syriacus`,
// and the Rose of Sharon model that every one of them renders with sits in the
// other album. `in_album` tells the two apart so the UI can badge them.
interface PlantRef {
  id: number;
  botanical: string | null;
  genus: string | null;
  species: string | null;
  cultivar: string | null;
  common: string | null;
}

type Embedded = PlantModel & { plants: PlantRef | PlantRef[] | null };

const one = (p: Embedded["plants"]): PlantRef | null => (Array.isArray(p) ? (p[0] ?? null) : p);

const same = (a: string | null, b: string | null) =>
  (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

// Scopes that claim to speak for more than the plant they hang on. Anything
// narrower (a cultivar's own model, a species model) belongs to its own album
// and would be noise here.
const CROSS_ALBUM_SCOPES = new Set(["genus", "generic"]);

export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const genus = sp.get("genus")?.trim() || null;
  // An album with no species is a real album (the perennial Hibiscus
  // cultivars are all `species: null`), so an absent parameter means "the
  // species-less album", not "any species".
  const speciesParam = sp.get("species");
  const species = speciesParam && speciesParam.trim() ? speciesParam.trim() : null;

  if (!genus) {
    return NextResponse.json({ error: "genus is required" }, { status: 400 });
  }

  // One query for the whole genus, split in memory. The genus is already the
  // narrowest filter that catches both an album's own models and the stand-ins
  // aimed at it, so asking twice would cost a round trip to learn nothing.
  const { data, error } = await supabase
    .from("plant_models")
    .select(`${MODEL_COLUMNS},plants!inner(id,botanical,genus,species,cultivar,common)`)
    .neq("status", "rejected")
    .ilike("plants.genus", genus)
    .order("created_at", { ascending: false })
    .limit(60);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const models = ((data ?? []) as unknown as Embedded[])
    .map((row) => {
      const plant = one(row.plants);
      if (!plant) return null;
      const inAlbum = same(plant.species, species);
      if (!inAlbum && !CROSS_ALBUM_SCOPES.has(row.model_scope ?? "")) return null;

      const { plants: _drop, ...model } = row;
      void _drop;
      return {
        ...model,
        url: plantModelUrl(model.storage_path),
        posterUrl: plantModelPosterUrl(model.storage_path),
        plant,
        in_album: inAlbum,
      };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null);

  // This album's own models first and its primary at the very front, because
  // that is the one a rendering of these plants actually gets; borrowed
  // stand-ins sort last.
  models.sort((a, b) => {
    if (a.in_album !== b.in_album) return a.in_album ? -1 : 1;
    const ap = a.status === "primary" ? 0 : 1;
    const bp = b.status === "primary" ? 0 : 1;
    return ap - bp;
  });

  return NextResponse.json({ models });
}
