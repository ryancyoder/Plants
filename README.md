# Plants

The landscape plant catalog: 962 cultivars, their species albums, and the
photographs kept beside each cover.

## Why it is its own app

It grew up inside [VoiceData](https://github.com/ryancyoder/VoiceData), which is
a voice-driven database with a sales board, a calendar and a next-actions queue.
The catalog had nothing to do with any of that, and reaching it meant opening an
app that starts somewhere else.

Nothing outside the plant pages called these routes — no page, no library, no
fetch — so the seam was already there. This is the cut along it.

What came across: the catalog (now the root, because it is the whole app),
`/api/plants`, `/api/combinations`, `/api/design/library`, and the password gate.
What did not: the nav bar, the command palette and four quick-add overlays. A
standalone catalog offering to add a task would be advertising a door that opens
onto nothing.

## One database, two readers

Plants reads the **same Supabase project and the same tables** as VoiceData — it
is a second reader of one database, not a copy of it. Edit a cultivar here and
the change is simply there, everywhere.

| table | |
|---|---|
| `plants` | the catalog: 962 rows, genus/species/cultivar and the growing conditions |
| `plant_images` | every photograph found for a plant, and what was decided about it |
| `plant_models` | the 3D models kept against a plant, and which one renders |
| `pp_library_items` | design stamps and 2D plan symbols, shown in a drilled-into species and, unlocked, added and edited there |

`plant_images` carries a status: `accepted` is the cover (at most one),
**`extra`** is a photograph deliberately kept *beside* the cover, `candidate` is
found-but-undecided, `rejected` is refused-and-remembered, `superseded` was once
the cover. It has RLS on with **no policies**, so it is readable only by server
code holding the service-role key — which is why the extras are fetched through a
route rather than straight from the browser.

### The bucket must stay flat

`plantImageUrl()` keeps only the *basename* of whatever it is handed and rebuilds
the path. A photograph filed into a subfolder of `plant-images/` therefore 404s
and the card falls back to a leaf placeholder — with nothing in the database
looking wrong. Uploads go to the bucket root for that reason.

When checking whether a photo "works", test the URL the reader constructs, not
the one that was stored.

## Where photographs come from

Three ways in, and they do different jobs:

- **Upload photo** (in the editor) replaces the **cover**, and deletes the file it
  replaced. It is the only destructive one.
- **Also photographed** (in the editor) adds an **extra** with a caption, and
  leaves the cover alone.
- [**plantpix**](../plantpix) harvests candidates from public grower catalogues
  and from Immich, and `plantpix review` judges them at the workstation. Its
  captions are the same seven this app offers, so a photograph described in
  either place is labelled the same way.

## In 3D

A photograph answers *what is this plant*. It cannot answer *what does it look
like from the house*, which is the question a design is actually arguing about.
So a plant can also carry 3D models — `plant_models`, shaped like
`plant_images`: many rows per plant, at most one of them the one that counts.

| | |
|---|---|
| `plant_models` | every model kept against a plant, and what was decided about it |
| `plant-models` bucket | the files, foldered by plant id |

**glTF only** (`.glb` preferred). A GLB carries its geometry *and* its textures
in one file, which is what makes a bucket of bare objects usable without a
manifest explaining which `.jpg` belongs to which `.obj`. It is also the one
format a browser renders with no conversion step and Blender imports without
complaint.

`status` works like the photographs': **`primary`** is the model a rendering
gets, `alternate` is one kept beside it (another season, another age),
`superseded` was the primary once, and `candidate`/`rejected` are there for a
harvester that does not exist yet. *At most one primary per plant is enforced by
a partial unique index* — not by app code — so "the model for this plant" cannot
quietly become a question with two answers.

### The bucket is NOT flat

This is the opposite of `plant-images`, deliberately. `plantModelUrl()` uses the
stored path **verbatim** instead of reducing it to a basename, so models are
foldered by plant id (`520/model-1760000000000.glb`) and the bucket can be read
by eye. The two functions are therefore not interchangeable: hand a model path
to `plantImageUrl()` and the folder silently disappears.

### A model has to say what it is

`model_scope` is `cultivar` / `species` / `genus` / `generic` / **`generated`** /
`unknown`, and the card prints a warning for everything except `cultivar`.

This matters more than it does for photographs. A model *looks* authoritative —
it has volume and it casts a shadow — so an unlabelled generated shrub can reach
a client presentation without anyone asking where it came from. `generated`
means plausible for the name, not observed on the plant, and it says so on the
card even when the row names no cultivar.

### Uploads do not go through the app

The only flow here that does not post a file to a route. A GLB carries its
textures, so a usable plant is routinely 5–30 MB, and a serverless body caps out
around 4.5 MB on Vercel — the models worth having are exactly the ones that
would fail, and fail as an opaque 413. Instead:

1. `POST /api/plants/<id>/models/upload-url` mints a signed URL for a path *the
   server* chooses (the client never names its own path),
2. the browser PUTs the bytes straight to Supabase Storage,
3. `POST /api/plants/<id>/models` registers the row — after re-reading the first
   twelve bytes over a Range request to check they really say `glTF`.

That last step is what separates "the upload returned 200" from "there is a
model here": a signed URL will faithfully store a renamed `.obj` or half a
download, and both produce a viewer that spins forever and looks like a bug in
the app.

### What a rendering asks

`GET /api/models/lookup` is the seam for plot and Blender, which know a plant by
the name on the plan rather than by a row id:

```bash
curl -s -H "Cookie: rlm_session=$SESSION_TOKEN" \
  --get --data-urlencode "botanical=Hydrangea arborescens 'Blush'" \
  https://plants-seven-olive.vercel.app/api/models/lookup
```

It owns the one piece of judgement neither of them should re-implement: what to
do when the exact cultivar has no model. It walks **cultivar → species → genus**
and always says how far it fell, so a caller that must not substitute checks
`exact` rather than trusting that a 200 means a hit:

| field | |
|---|---|
| `matched_on` | `plant_id` / `botanical` / `cultivar` / `species` / `genus` |
| `exact` | false the moment it substituted |
| `model_scope` | what the geometry is, carried through |
| `plant` | the plant the model actually came from — not necessarily the one asked for |
| `height_in` | the real height to scale to |

`?fallback=0` turns substitution off; `?season=fall` asks for a particular one.
The file itself is in a public bucket, so a caller needs this route once and
then downloads without talking to the app again.

`GET /api/models/coverage` answers "where have I got to" for the whole catalog
in one request — which is what the **3D** badge on a card is reading.

### Pushing one from the workstation

For a model that was just generated or exported and is sitting in a directory,
rather than one on the machine you happen to be browsing from:

```bash
node scripts/push-model.mjs ./annabelle.glb --botanical "Hydrangea arborescens 'Annabelle'"
node scripts/push-model.mjs ./maple.glb --plant 412 --scope species --season fall --alternate
```

It needs `SUPABASE_SERVICE_ROLE_KEY` (the table is RLS-on with no policies, so
the anon key would read and write nothing — silently) and takes `--dry-run`.

## Running it

```bash
npm install
npm run dev        # http://localhost:3000
npm run build
npx tsc --noEmit
```

### Environment

| variable | |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | the Supabase project |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | public by design; ships in the browser bundle |
| `SUPABASE_SERVICE_ROLE_KEY` | server only. Bypasses RLS on the whole project |
| `APP_PASSWORD` | the password the login screen asks for |
| `SESSION_TOKEN` | the cookie value that counts as a valid session |

**`SESSION_TOKEN` is not optional in a deployment.** The middleware treats a
missing one as "do not lock anyone out", which lets a first deploy come up before
the env vars are set — and leaves the catalog and every API route behind it open
until it exists. Give each deployment its own, so a stolen cookie from one app
does not open another.
