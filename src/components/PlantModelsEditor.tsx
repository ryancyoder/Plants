"use client";

import { useEffect, useRef, useState } from "react";
import { Box, Loader2, Star, Trash2, Upload, X } from "lucide-react";
import { supabase } from "@/lib/supabaseClient";
import {
  MODEL_SCOPES,
  MODEL_SEASONS,
  PLANT_MODELS_BUCKET,
  formatBytes,
  looksLikeGlb,
  modelStandInLabel,
  type ModelScope,
  type PlantModel,
} from "@/lib/plantModels";

type ModelWithUrl = PlantModel & { url?: string | null };

// Add, promote and remove a plant's 3D models.
//
// Lives in the editor rather than on the read-only card because it writes, and
// the library's rule is that nothing is written while the page is locked.
//
// The upload is the one flow in this app that does not post a file to a route.
// A GLB carries its textures, so a usable plant is routinely 5–30 MB and a
// serverless body caps out around 4.5 MB — the models worth having are exactly
// the ones that would fail. Instead the server mints a signed URL for a path it
// chose, the bytes go straight to Storage from here, and a second call registers
// the row. Three steps, but no size ceiling and no file passing through Vercel.
export function PlantModelsEditor({
  plantId,
  cultivar,
}: {
  plantId: number;
  cultivar?: string | null;
}) {
  const [models, setModels] = useState<ModelWithUrl[] | null>(null);
  const [scope, setScope] = useState<ModelScope>("generated");
  const [caption, setCaption] = useState("");
  const [season, setSeason] = useState("");
  const [heightIn, setHeightIn] = useState("");
  const [credit, setCredit] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/plants/${plantId}/models`)
      .then((r) => (r.ok ? r.json() : { models: [] }))
      .then((d: { models?: ModelWithUrl[] }) => live && setModels(d.models ?? []))
      .catch(() => live && setModels([]));
    return () => {
      live = false;
    };
  }, [plantId]);

  const add = async (file: File) => {
    setError(null);
    try {
      if (!/\.(glb|gltf)$/i.test(file.name)) {
        throw new Error("Only .glb or .gltf files can be stored as models.");
      }

      // Check the header here, before anything is uploaded. The route checks it
      // again server-side (this is a browser, and a browser can be bypassed),
      // but catching a renamed file now saves pushing 30 MB to find out.
      if (/\.glb$/i.test(file.name)) {
        const head = await file.slice(0, 12).arrayBuffer();
        if (!looksLikeGlb(head)) {
          throw new Error("That file is not a GLB — its header does not say glTF.");
        }
      }

      setBusy("Preparing…");
      const urlRes = await fetch(`/api/plants/${plantId}/models/upload-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: file.name }),
      });
      if (!urlRes.ok) {
        const d = await urlRes.json().catch(() => ({}));
        throw new Error(d.error || `Could not start the upload (${urlRes.status})`);
      }
      const { path, token } = (await urlRes.json()) as { path: string; token: string };

      setBusy(`Uploading ${formatBytes(file.size)}…`);
      const { error: upErr } = await supabase.storage
        .from(PLANT_MODELS_BUCKET)
        .uploadToSignedUrl(path, token, file, {
          contentType: /\.gltf$/i.test(file.name) ? "model/gltf+json" : "model/gltf-binary",
        });
      if (upErr) throw new Error(upErr.message);

      setBusy("Saving…");
      const res = await fetch(`/api/plants/${plantId}/models`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storage_path: path,
          bytes: file.size,
          model_scope: scope,
          // 'generated' is the only source the app itself can vouch for having
          // come from a generator; everything else arrived as a file he had.
          source: scope === "generated" ? "generated" : "upload",
          caption: caption.trim() || null,
          season: season || null,
          height_in: heightIn.trim() || null,
          credit: credit.trim() || null,
          // The first model for a plant is the point of uploading it.
          make_primary: !models || models.length === 0,
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `Save failed (${res.status})`);
      }
      const d: { model: ModelWithUrl } = await res.json();
      setModels((xs) => [d.model, ...(xs ?? [])].sort(primaryFirst));
      setCaption("");
      setSeason("");
      setHeightIn("");
      setCredit("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const promote = async (modelId: number) => {
    setBusy("Promoting…");
    setError(null);
    try {
      const res = await fetch(`/api/plants/${plantId}/models`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId, status: "primary" }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `Could not promote (${res.status})`);
      }
      setModels((xs) =>
        (xs ?? [])
          .map((m) =>
            m.id === modelId
              ? { ...m, status: "primary" as const }
              : m.status === "primary"
                ? { ...m, status: "superseded" as const }
                : m,
          )
          .sort(primaryFirst),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not promote");
    } finally {
      setBusy(null);
    }
  };

  const setRowScope = async (modelId: number, next: ModelScope) => {
    setError(null);
    try {
      const res = await fetch(`/api/plants/${plantId}/models`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId, model_scope: next }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `Could not update (${res.status})`);
      }
      setModels((xs) =>
        (xs ?? []).map((m) => (m.id === modelId ? { ...m, model_scope: next } : m)),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update");
    }
  };

  const remove = async (modelId: number) => {
    setBusy("Removing…");
    setError(null);
    try {
      const res = await fetch(`/api/plants/${plantId}/models?modelId=${modelId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `Remove failed (${res.status})`);
      }
      // The route promotes a survivor when the primary goes, so refetch rather
      // than guess which one it chose.
      const fresh = await fetch(`/api/plants/${plantId}/models`)
        .then((r) => (r.ok ? r.json() : { models: [] }))
        .catch(() => ({ models: [] }));
      setModels(((fresh as { models?: ModelWithUrl[] }).models ?? []).sort(primaryFirst));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Remove failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <fieldset className="mb-5">
      <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">
        3D models{models && models.length ? ` (${models.length})` : ""}
      </legend>
      <p className="mb-2 text-xs text-zinc-500 dark:text-zinc-400">
        A GLB carries its own textures, so one file is the whole plant. The primary model is what
        a rendering gets when it asks for this plant by name.
      </p>

      {models && models.length > 0 && (
        <ul className="mb-3 flex flex-col gap-2">
          {models.map((m) => {
            const standIn = modelStandInLabel(m.model_scope as ModelScope | null, cultivar);
            return (
              <li
                key={m.id}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-200 px-2.5 py-2 text-xs dark:border-zinc-700"
              >
                <Box size={14} className="shrink-0 text-zinc-400" />
                <span className="font-medium text-zinc-700 dark:text-zinc-200">
                  {m.caption || m.season || m.format.toUpperCase()}
                </span>
                {m.status === "primary" && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-zinc-900 px-1.5 py-0.5 text-[10px] font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">
                    <Star size={9} /> primary
                  </span>
                )}
                <span className="text-zinc-400">{formatBytes(m.bytes)}</span>

                {/* Correcting what a model claims to be has to be possible here:
                    a model uploaded as a stand-in is often identified later, and
                    the badge is only worth trusting if it can be made right. */}
                <select
                  value={(m.model_scope as string) || "unknown"}
                  onChange={(e) => setRowScope(m.id, e.target.value as ModelScope)}
                  title="What this geometry actually depicts"
                  className="rounded border border-zinc-300 bg-white px-1 py-0.5 text-[11px] text-zinc-700 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200"
                >
                  {MODEL_SCOPES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>

                {standIn && <span className="text-amber-600 dark:text-amber-400">{standIn.short}</span>}

                <span className="ml-auto flex items-center gap-1">
                  {m.status !== "primary" && (
                    <button
                      type="button"
                      onClick={() => promote(m.id)}
                      disabled={!!busy}
                      title="Make this the model a rendering gets"
                      className="rounded px-1.5 py-0.5 text-[11px] font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:text-blue-400 dark:hover:bg-blue-950"
                    >
                      Make primary
                    </button>
                  )}
                  {m.url && (
                    <a
                      href={m.url}
                      download
                      className="rounded px-1.5 py-0.5 text-[11px] text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                    >
                      Download
                    </a>
                  )}
                  <button
                    type="button"
                    onClick={() => remove(m.id)}
                    disabled={!!busy}
                    title="Remove this model"
                    aria-label="Remove this model"
                    className="flex h-6 w-6 items-center justify-center rounded text-zinc-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50 dark:hover:bg-red-950"
                  >
                    <Trash2 size={12} />
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-zinc-500 dark:text-zinc-400">What this model is</span>
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as ModelScope)}
            className="rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-sm text-zinc-900 outline-none focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
          >
            {MODEL_SCOPES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-zinc-500 dark:text-zinc-400">Season (optional)</span>
          <select
            value={season}
            onChange={(e) => setSeason(e.target.value)}
            className="rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-sm text-zinc-900 outline-none focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
          >
            <option value="">—</option>
            {MODEL_SEASONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            Modelled height, inches (optional)
          </span>
          <input
            type="number"
            value={heightIn}
            onChange={(e) => setHeightIn(e.target.value)}
            placeholder="so a rendering can scale it"
            className="rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-sm text-zinc-900 outline-none focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-zinc-500 dark:text-zinc-400">Credit (optional)</span>
          <input
            type="text"
            value={credit}
            onChange={(e) => setCredit(e.target.value)}
            placeholder="who made it"
            className="rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-sm text-zinc-900 outline-none focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
          />
        </label>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          placeholder="Caption (summer habit, year three…)"
          className="min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-sm text-zinc-900 outline-none focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
        />
        <input
          ref={fileRef}
          type="file"
          accept=".glb,.gltf,model/gltf-binary,model/gltf+json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) add(f);
          }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={!!busy}
          className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-2.5 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}
          {busy ?? "Add model"}
        </button>
      </div>

      {error && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-red-600 dark:text-red-400">
          <X size={13} className="mt-0.5 shrink-0" />
          {error}
        </p>
      )}
    </fieldset>
  );
}

const primaryFirst = (a: ModelWithUrl, b: ModelWithUrl) =>
  a.status === "primary" ? -1 : b.status === "primary" ? 1 : 0;
