#!/usr/bin/env node
// Put a GLB onto a plant from the workstation.
//
// The app's uploader is the right tool when the file is already on the machine
// you are browsing from. This is for the other case: a model that was just
// generated or exported, sitting in a directory, named after nothing in
// particular — where the catalog is not the thing you are looking at and
// opening it to drag a file in is the slow way round.
//
// It talks to Supabase directly with the service-role key rather than through
// the app, so it does not need the app running, a session cookie, or a
// deployment. That also means it is not behind the password gate: it is a
// workstation tool and the key is the permission.
//
//   node scripts/push-model.mjs ./annabelle.glb --botanical "Hydrangea arborescens 'Annabelle'"
//   node scripts/push-model.mjs ./maple.glb --plant 412 --scope species --season fall
//   node scripts/push-model.mjs ./shrub.glb --plant 412 --alternate --caption "year three"
//
// Flags:
//   --plant <id>          the plant to file it against
//   --botanical "<name>"  resolve the plant by name instead
//   --scope <s>           cultivar|species|genus|generic|generated|unknown  (default: generated)
//   --season <s>          summer|fall|winter|bloom
//   --height-in <n>       the real height the geometry is built to
//   --caption "<text>"    what this model is
//   --credit "<text>"     who made it
//   --source "<text>"     default: "generated"
//   --alternate           keep it beside the primary instead of becoming it
//   --dry-run             say what would happen and stop

import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

const BUCKET = "plant-models";
const SCOPES = ["cultivar", "species", "genus", "generic", "generated", "unknown"];
const GLB_MAGIC = 0x46546c67; // 'glTF'

function die(msg) {
  console.error(`push-model: ${msg}`);
  process.exit(1);
}

// --- arguments -------------------------------------------------------------

const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--alternate" || a === "--dry-run") {
    flags[a.replace(/^--/, "")] = true;
  } else if (a.startsWith("--")) {
    flags[a.replace(/^--/, "")] = argv[++i];
  } else {
    positional.push(a);
  }
}

const file = positional[0];
if (!file) die("give me a .glb file. See the header of this script for usage.");
if (!/\.(glb|gltf)$/i.test(file)) die("only .glb or .gltf files can be stored as models.");

const scope = flags.scope ?? "generated";
if (!SCOPES.includes(scope)) die(`--scope must be one of: ${SCOPES.join(", ")}`);

// --- environment -----------------------------------------------------------

// Read .env.local the way Next would, so this works in a checkout that has
// never had the variables exported into a shell.
async function loadEnvLocal() {
  for (const name of [".env.local", ".env"]) {
    try {
      const text = await readFile(resolve(process.cwd(), name), "utf8");
      for (const line of text.split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && !process.env[m[1]]) {
          process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
        }
      }
    } catch {
      // Not there; the shell may already carry the variables.
    }
  }
}
await loadEnvLocal();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url) die("NEXT_PUBLIC_SUPABASE_URL is not set.");
if (!key) {
  die(
    "SUPABASE_SERVICE_ROLE_KEY is not set. The models table is RLS-on with no policies, so the anon key would read and write nothing — silently.",
  );
}

const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

// --- the file --------------------------------------------------------------

const bytes = await readFile(resolve(file)).catch(() => die(`cannot read ${file}`));

// Same header check the app does, for the same reason: a renamed .obj or a
// truncated download uploads perfectly and then shows an empty viewer, which
// reads as a broken app rather than a broken file.
if (/\.glb$/i.test(file)) {
  if (bytes.length < 12 || bytes.readUInt32LE(0) !== GLB_MAGIC) {
    die(`${basename(file)} is not a GLB — its first bytes do not say glTF.`);
  }
  const version = bytes.readUInt32LE(4);
  if (version !== 1 && version !== 2) die(`unexpected GLB version ${version}.`);
}

// --- which plant -----------------------------------------------------------

let plantId = flags.plant ? Number(flags.plant) : null;
let plantRow = null;

if (plantId != null) {
  if (!Number.isInteger(plantId)) die("--plant must be an integer id.");
  const { data, error } = await db
    .from("plants")
    .select("id,botanical,cultivar")
    .eq("id", plantId)
    .maybeSingle();
  if (error) die(error.message);
  if (!data) die(`no plant with id ${plantId}.`);
  plantRow = data;
} else if (flags.botanical) {
  const { data, error } = await db
    .from("plants")
    .select("id,botanical,cultivar")
    .ilike("botanical", flags.botanical)
    .limit(5);
  if (error) die(error.message);
  if (!data?.length) die(`no plant whose botanical name is "${flags.botanical}".`);
  if (data.length > 1) {
    die(
      `"${flags.botanical}" matches ${data.length} rows (${data
        .map((r) => `${r.id}: ${r.botanical}`)
        .join("; ")}). Use --plant <id>.`,
    );
  }
  plantRow = data[0];
  plantId = plantRow.id;
} else {
  die("say which plant: --plant <id> or --botanical \"<name>\".");
}

const makePrimary = !flags.alternate;
const storagePath = `${plantId}/model-${Date.now()}.${/\.gltf$/i.test(file) ? "gltf" : "glb"}`;

console.log(`plant   ${plantId}  ${plantRow.botanical ?? "(unnamed)"}`);
const size =
  bytes.length < 1024
    ? `${bytes.length} B`
    : bytes.length < 1048576
      ? `${Math.round(bytes.length / 1024)} KB`
      : `${(bytes.length / 1048576).toFixed(1)} MB`;
console.log(`file    ${basename(file)}  ${size}`);
console.log(`scope   ${scope}${makePrimary ? "  (becomes the primary)" : "  (alternate)"}`);
console.log(`path    ${BUCKET}/${storagePath}`);

if (flags["dry-run"]) {
  console.log("\n--dry-run: nothing was uploaded.");
  process.exit(0);
}

// --- upload, then register -------------------------------------------------

const { error: upErr } = await db.storage.from(BUCKET).upload(storagePath, bytes, {
  contentType: /\.gltf$/i.test(file) ? "model/gltf+json" : "model/gltf-binary",
  upsert: false,
});
if (upErr) die(`upload failed: ${upErr.message}`);

// At most one primary per plant is a partial unique index, so the sitting
// primary has to stand down before the new row claims the status — otherwise
// the insert is rejected and the object is already in the bucket.
if (makePrimary) {
  const { error } = await db
    .from("plant_models")
    .update({ status: "superseded" })
    .eq("plant_id", plantId)
    .eq("status", "primary");
  if (error) {
    await db.storage.from(BUCKET).remove([storagePath]);
    die(`could not stand down the previous primary: ${error.message}`);
  }
}

const { data: row, error: insErr } = await db
  .from("plant_models")
  .insert({
    plant_id: plantId,
    status: makePrimary ? "primary" : "alternate",
    source: flags.source ?? (scope === "generated" ? "generated" : "upload"),
    credit: flags.credit ?? null,
    model_scope: scope,
    storage_path: storagePath,
    format: /\.gltf$/i.test(file) ? "gltf" : "glb",
    bytes: bytes.length,
    height_in: flags["height-in"] ? Math.round(Number(flags["height-in"])) : null,
    season: flags.season ?? null,
    caption: flags.caption ?? null,
    notes: "pushed from the workstation",
    reviewed_at: new Date().toISOString(),
  })
  .select("id,status,storage_path")
  .maybeSingle();

if (insErr || !row) {
  // Never leave an object behind a failed insert.
  await db.storage.from(BUCKET).remove([storagePath]);
  die(`insert failed: ${insErr?.message ?? "no row returned"}`);
}

console.log(`\nok      model ${row.id} (${row.status})`);
console.log(`url     ${url}/storage/v1/object/public/${BUCKET}/${storagePath}`);
