#!/usr/bin/env node
// Put a thumbnail onto a model from the workstation.
//
// The browser makes its own thumbnail the moment a model is uploaded, so most
// models never need this. It exists for the two cases the browser cannot cover:
// models that predate thumbnails altogether, and a capture that came out wrong
// because the tab lost its WebGL context halfway through.
//
// It is also the better picture. A still rendered in Blender can be lit and
// framed deliberately, where the in-browser capture is whatever <model-viewer>
// draws at a fixed orbit — fine for a tile, not always flattering.
//
// The path is derived from the model's own (`…/model-123.glb` →
// `…/model-123.poster.png`), so there is no row to update and nothing to keep
// in step: uploading the object *is* giving the model a thumbnail.
//
//   node scripts/push-poster.mjs ./hibiscus.png --model 5
//   node scripts/push-poster.mjs ./juniper.png --plant 813
//   node scripts/push-poster.mjs ./shrub.png --model 5 --dry-run
//
// Flags:
//   --model <id>   the plant_models row to give a thumbnail
//   --plant <id>   that plant's primary model, if you would rather not look up the row
//   --dry-run      say what would happen and stop

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

const BUCKET = "plant-models";
// \x89PNG\r\n\x1a\n — the same check the poster route makes server-side.
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function die(msg) {
  console.error(`push-poster: ${msg}`);
  process.exit(1);
}

// --- arguments -------------------------------------------------------------
const argv = process.argv.slice(2);
let file = null;
let modelId = null;
let plantId = null;
let dryRun = false;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--model") modelId = Number(argv[++i]);
  else if (a === "--plant") plantId = Number(argv[++i]);
  else if (a === "--dry-run") dryRun = true;
  else if (a.startsWith("--")) die(`unknown flag ${a}`);
  else if (file === null) file = a;
  else die("give exactly one PNG");
}

if (!file) die("usage: push-poster.mjs <poster.png> --model <id> | --plant <id>");
if (modelId == null && plantId == null) die("say which model: --model <id> or --plant <id>");
if (modelId != null && !Number.isInteger(modelId)) die("--model wants an integer");
if (plantId != null && !Number.isInteger(plantId)) die("--plant wants an integer");

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

// --- the file --------------------------------------------------------------
const bytes = await readFile(resolve(process.cwd(), file)).catch(() => die(`cannot read ${file}`));
if (bytes.length < 8 || PNG_SIGNATURE.some((b, i) => bytes[i] !== b)) {
  die("that file is not a PNG — its signature does not say so. Export a PNG, not a JPEG.");
}

// --- the model it belongs to ----------------------------------------------
const supabase = createClient(url, key, { auth: { persistSession: false } });

let row;
if (modelId != null) {
  const { data, error } = await supabase
    .from("plant_models")
    .select("id,plant_id,storage_path,status")
    .eq("id", modelId)
    .maybeSingle();
  if (error) die(error.message);
  if (!data) die(`no model with id ${modelId}`);
  row = data;
} else {
  const { data, error } = await supabase
    .from("plant_models")
    .select("id,plant_id,storage_path,status")
    .eq("plant_id", plantId)
    .eq("status", "primary")
    .maybeSingle();
  if (error) die(error.message);
  if (!data) die(`plant ${plantId} has no primary model`);
  row = data;
}

const posterPath = `${row.storage_path.replace(/\.(glb|gltf)$/i, "")}.poster.png`;

if (dryRun) {
  console.log(`would upload ${bytes.length} bytes`);
  console.log(`  model ${row.id} (plant ${row.plant_id}, ${row.status})`);
  console.log(`  → ${BUCKET}/${posterPath}`);
  process.exit(0);
}

const { error: upErr } = await supabase.storage
  .from(BUCKET)
  .upload(posterPath, bytes, { contentType: "image/png", upsert: true });
if (upErr) die(upErr.message);

console.log(`thumbnail set for model ${row.id} (plant ${row.plant_id})`);
console.log(`${url}/storage/v1/object/public/${BUCKET}/${posterPath}`);
