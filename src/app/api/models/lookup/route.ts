import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";
import { MODEL_COLUMNS, plantModelUrl, type PlantModel } from "@/lib/plantModels";

// "Which model do I render for this plant?" — asked by something that is not
// this app.
//
// plot draws in 2D and Blender renders in 3D, and both already know a plant by
// the name on the plan ("Hydrangea arborescens 'Annabelle'"), not by a row id in
// a catalog they do not read. So the seam is the name, and this route owns the
// one piece of judgement neither of them should re-implement: what to do when
// the exact cultivar has no model.
//
// It answers with a URL into the public plant-models bucket, so a caller needs
// this route once and then downloads the file without talking to the app again.
// The route itself sits behind the password gate like everything else — a local
// script sends `Cookie: rlm_session=$SESSION_TOKEN`.

interface PlantRef {
  id: number;
  botanical: string | null;
  genus: string | null;
  species: string | null;
  cultivar: string | null;
  common: string | null;
  height_in: number | null;
  is_choice: boolean | null;
}

const PLANT_REF = "id,botanical,genus,species,cultivar,common,height_in,is_choice";

// `Acer palmatum 'Bloodgood'` → its three parts. The inverse of
// composeBotanical(), and deliberately forgiving about the quote character:
// a name copied off a plan carries whichever apostrophe the editor inserted.
//
// Both curly quotes have to be listed. Carrying only the closing one (U+2019,
// the apostrophe a word processor substitutes) made a name typed with a real
// opening quote — `‘Blush’` — fail to yield a cultivar at all, and the request
// then fell down to a species stand-in while an exact model sat right there.
// A silent downgrade, which is the worst failure this route has.
const CULTIVAR_QUOTES = /['‘’“”"]([^'‘’“”"]+)['‘’“”"]/;

function parseBotanical(name: string): { genus: string | null; species: string | null; cultivar: string | null } {
  const cvMatch = name.match(CULTIVAR_QUOTES);
  const cultivar = cvMatch ? cvMatch[1].trim() : null;
  const rest = (cvMatch ? name.replace(cvMatch[0], "") : name).trim().split(/\s+/).filter(Boolean);
  return {
    genus: rest[0] ?? null,
    species: rest[1] ?? null,
    cultivar,
  };
}

type Embedded = PlantModel & { plants: PlantRef | PlantRef[] | null };

const one = (p: Embedded["plants"]): PlantRef | null =>
  Array.isArray(p) ? (p[0] ?? null) : p;

// Primary models whose plant matches the given taxonomic filters. `!inner` makes
// the join a filter rather than a decoration, so a model whose plant does not
// match drops out instead of coming back with a null plant.
async function primaryModelsWhere(
  filters: Partial<Record<"genus" | "species" | "cultivar" | "id", string | number>>,
  season: string | null,
) {
  let q = supabase
    .from("plant_models")
    .select(`${MODEL_COLUMNS},plants!inner(${PLANT_REF})`)
    .eq("status", "primary");

  for (const [k, v] of Object.entries(filters)) {
    // Case-insensitive on names: a plan may say "hydrangea", the catalog says
    // "Hydrangea", and failing to find a model over a capital letter is the
    // kind of bug nobody reports because they assume there is no model.
    q = typeof v === "string" ? q.ilike(`plants.${k}`, v) : q.eq(`plants.${k}`, v);
  }
  if (season) q = q.eq("season", season);

  const { data, error } = await q.limit(25);
  return { rows: (data ?? []) as unknown as Embedded[], error };
}

export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  // Number(null) is 0, not NaN, so reading an absent parameter straight into
  // Number() produces a plausible-looking id 0 that passes an isInteger check
  // and then matches nothing. A request with no parameters at all came back 404
  // "no model for that plant" instead of 400 "you did not say which plant".
  const rawPlantId = sp.get("plant_id");
  const plantId = rawPlantId === null || rawPlantId.trim() === "" ? NaN : Number(rawPlantId);
  const botanical = sp.get("botanical")?.trim() || null;
  const season = sp.get("season")?.trim() || null;
  // Fallback is on by default: a rendering with a species stand-in beats a hole
  // in the planting plan, as long as the answer says what it handed back.
  const allowFallback = sp.get("fallback") !== "0";

  let genus = sp.get("genus")?.trim() || null;
  let species = sp.get("species")?.trim() || null;
  let cultivar = sp.get("cultivar")?.trim() || null;

  if (botanical && !genus) {
    const parsed = parseBotanical(botanical);
    genus = parsed.genus;
    species = parsed.species;
    cultivar = parsed.cultivar;
  }

  if (!Number.isInteger(plantId) && !genus) {
    return NextResponse.json(
      { error: "pass plant_id, botanical, or at least genus" },
      { status: 400 },
    );
  }

  const answer = (
    row: Embedded,
    matched: "plant_id" | "botanical" | "cultivar" | "species" | "genus",
  ) => {
    const plant = one(row.plants);
    const { plants: _drop, ...model } = row;
    void _drop;
    return NextResponse.json({
      found: true,
      // How close the model is to what was asked for. A caller that must not
      // substitute checks this rather than trusting that a 200 means an exact
      // hit — which is the mistake the photograph side of this catalog made for
      // a year.
      matched_on: matched,
      exact: matched === "plant_id" || matched === "botanical" || matched === "cultivar",
      model_scope: row.model_scope,
      // The plant the geometry actually came from, which is not necessarily the
      // plant that was asked about.
      plant,
      // The height to scale to: the model's own figure if it has one, else the
      // catalog's for the plant that was asked about.
      height_in: row.height_in,
      model: { ...model, url: plantModelUrl(row.storage_path) },
    });
  };

  // 1. An id, or a full botanical name, is an exact request.
  if (Number.isInteger(plantId)) {
    const { rows, error } = await primaryModelsWhere({ id: plantId }, season);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (rows.length) return answer(rows[0], "plant_id");
  }

  if (botanical) {
    const { data, error } = await supabase
      .from("plant_models")
      .select(`${MODEL_COLUMNS},plants!inner(${PLANT_REF})`)
      .eq("status", "primary")
      .ilike("plants.botanical", botanical)
      .limit(1);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const rows = (data ?? []) as unknown as Embedded[];
    if (rows.length) return answer(rows[0], "botanical");
  }

  // 2. Genus + species + cultivar, which catches a name spelled differently
  //    from the stored `botanical` string.
  if (genus && species && cultivar) {
    const { rows, error } = await primaryModelsWhere({ genus, species, cultivar }, season);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (rows.length) return answer(rows[0], "cultivar");
  }

  if (!allowFallback) {
    return NextResponse.json({ found: false, asked: { genus, species, cultivar } }, { status: 404 });
  }

  // 3. Up the taxonomy. A cultivar is a selection of a species, so another
  //    cultivar's model is usually the right shape and the wrong colour — fine
  //    for massing, and labelled so the renderer knows.
  if (genus && species) {
    const { rows, error } = await primaryModelsWhere({ genus, species }, season);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (rows.length) {
      // The catalog already nominates one cultivar per species as the "choice";
      // that is the considered answer to "which of these represents the group",
      // so reuse it instead of inventing a second rule here.
      const chosen = rows.find((r) => one(r.plants)?.is_choice) ?? rows[0];
      return answer(chosen, "species");
    }
  }

  // 4. Genus only. A stretch, and says so.
  if (genus) {
    const { rows, error } = await primaryModelsWhere({ genus }, season);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (rows.length) return answer(rows[0], "genus");
  }

  return NextResponse.json(
    { found: false, asked: { genus, species, cultivar }, season },
    { status: 404 },
  );
}
