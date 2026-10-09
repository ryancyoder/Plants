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
| `pp_library_items` | design stamps, shown against a drilled-into species |

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
