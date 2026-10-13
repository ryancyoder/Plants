"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Box, Loader2, RotateCcw } from "lucide-react";
import {
  formatBytes,
  modelStandInLabel,
  type ModelScope,
  type PlantModel,
} from "@/lib/plantModels";

// <model-viewer> is a web component, so React only needs to know the tag exists.
// Typing it loosely is deliberate: the element has ~80 attributes and spelling
// out the handful used here as `string` would be a worse lie than `unknown`.
//
// Augmenting JSX.IntrinsicElements is the only way to teach TypeScript about a
// custom element, and that interface lives inside a namespace — so the rule
// against namespaces cannot be satisfied here without giving up JSX for this
// element entirely.
declare module "react" {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      "model-viewer": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          src?: string;
          alt?: string;
          poster?: string;
          "camera-controls"?: boolean | "";
          "auto-rotate"?: boolean | "";
          "shadow-intensity"?: string;
          "environment-image"?: string;
          exposure?: string;
          "interaction-prompt"?: string;
          "touch-action"?: string;
          loading?: string;
        },
        HTMLElement
      >;
    }
  }
}

type ModelWithUrl = PlantModel & { url?: string | null };

// A plant, turned around.
//
// The catalog's photographs answer "what is this plant"; they cannot answer
// "what does it look like from the house", which is the question a design is
// actually arguing about. A model can be turned, so the viewer's whole job is to
// make turning it cheap — no download, no Blender, no waiting.
//
// The element is imported on mount rather than at module scope. model-viewer
// registers a custom element and reaches for `window` as it loads, so importing
// it eagerly breaks the server render of a page where most plants have no model
// to show anyway.
export function PlantModelViewer({
  model,
  posterUrl,
  cultivar,
  alt,
  className = "h-72",
}: {
  model: ModelWithUrl;
  posterUrl?: string | null;
  cultivar?: string | null;
  alt?: string | null;
  className?: string;
}) {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const hostRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let live = true;
    import("@google/model-viewer")
      .then(() => live && setReady(true))
      .catch(() => live && setFailed("The 3D viewer could not be loaded."));
    return () => {
      live = false;
    };
  }, []);

  // `load` and `error` are element events, not React ones, so they are attached
  // by hand. Without the error listener a model that 404s shows a spinner for
  // ever, which reads as a slow connection rather than a missing file.
  useEffect(() => {
    const el = hostRef.current;
    if (!el || !ready) return;
    const onLoad = () => setLoaded(true);
    const onError = () => setFailed("This model could not be displayed.");
    el.addEventListener("load", onLoad);
    el.addEventListener("error", onError);
    return () => {
      el.removeEventListener("load", onLoad);
      el.removeEventListener("error", onError);
    };
  }, [ready, model.id]);

  // The element owns the camera, so recentring means asking it rather than
  // re-rendering: there is no way back from a viewpoint you have dragged behind
  // the model except through the element's own API.
  const reset = () => {
    const el = hostRef.current as
      | (HTMLElement & { resetTurntableRotation?: () => void; cameraOrbit?: string })
      | null;
    if (!el) return;
    el.resetTurntableRotation?.();
    el.cameraOrbit = "0deg 75deg auto";
  };

  const standIn = modelStandInLabel(model.model_scope as ModelScope | null, cultivar);
  const url = model.url ?? null;

  if (!url) return null;

  return (
    <div className="mb-4">
      <div
        className={`relative overflow-hidden rounded-xl border border-zinc-100 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 ${className}`}
      >
        {ready && !failed && (
          <model-viewer
            ref={hostRef as never}
            src={url}
            alt={alt || "3D model of this plant"}
            poster={posterUrl || undefined}
            camera-controls=""
            auto-rotate=""
            shadow-intensity="1"
            exposure="1"
            touch-action="pan-y"
            loading="lazy"
            style={{ width: "100%", height: "100%", backgroundColor: "transparent" }}
          />
        )}

        {!failed && !loaded && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 text-xs text-zinc-400">
            <Loader2 size={14} className="animate-spin" />
            Loading model…
          </div>
        )}

        {failed && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-4 text-center text-xs text-zinc-500 dark:text-zinc-400">
            <AlertTriangle size={16} className="text-amber-500" />
            {failed}
          </div>
        )}

        {loaded && (
          <button
            type="button"
            onClick={reset}
            title="Recentre the view"
            aria-label="Recentre the view"
            className="absolute bottom-2 right-2 flex h-7 w-7 items-center justify-center rounded-full bg-black/50 text-white transition-colors hover:bg-black/70"
          >
            <RotateCcw size={13} />
          </button>
        )}
      </div>

      {/* What the geometry is, said plainly. A model looks authoritative in a
          way a photograph does not — it has volume and casts a shadow — so an
          unlabelled generated shrub can reach a client presentation without
          anyone asking where it came from. */}
      {standIn && (
        <p className="mt-2 flex items-start gap-1.5 rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          {standIn.full}
        </p>
      )}

      <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-400">
        <span className="inline-flex items-center gap-1">
          <Box size={12} />
          {model.format.toUpperCase()}
        </span>
        {model.bytes != null && <span>{formatBytes(model.bytes)}</span>}
        {model.season && <span>{model.season}</span>}
        {model.credit && <span>{model.credit}</span>}
        <a
          href={url}
          download
          className="font-medium text-blue-600 hover:underline dark:text-blue-400"
        >
          Download
        </a>
      </p>
    </div>
  );
}

// The read-only side of a plant card: fetch whatever models exist and show the
// primary one, with the alternates as a row of chips to switch between.
//
// Fetched rather than passed in, exactly like ExtraPhotos: nothing else on the
// page needs them, and a plant with no model (nearly all of them, for a while
// yet) renders nothing and costs one request that returns an empty list.
export function PlantModels({
  plantId,
  posterUrl,
  cultivar,
  botanical,
}: {
  plantId: number;
  posterUrl?: string | null;
  cultivar?: string | null;
  botanical?: string | null;
}) {
  const [models, setModels] = useState<ModelWithUrl[] | null>(null);
  const [activeId, setActiveId] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/plants/${plantId}/models`)
      .then((r) => (r.ok ? r.json() : { models: [] }))
      .then((d: { models?: ModelWithUrl[] }) => {
        if (!live) return;
        const list = d.models ?? [];
        setModels(list);
        setActiveId(list.find((m) => m.status === "primary")?.id ?? list[0]?.id ?? null);
      })
      .catch(() => live && setModels([]));
    return () => {
      live = false;
    };
  }, [plantId]);

  if (!models || models.length === 0) return null;
  const active = models.find((m) => m.id === activeId) ?? models[0];

  return (
    <div>
      <p className="mb-1.5 text-xs font-medium text-zinc-400">
        In 3D{models.length > 1 ? ` (${models.length} models)` : ""}
      </p>
      <PlantModelViewer
        model={active}
        posterUrl={posterUrl}
        cultivar={cultivar}
        alt={botanical}
      />
      {models.length > 1 && (
        <div className="-mt-2 mb-4 flex flex-wrap gap-1.5">
          {models.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setActiveId(m.id)}
              className={`rounded-full border px-2 py-0.5 text-xs transition-colors ${
                m.id === active.id
                  ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                  : "border-zinc-200 text-zinc-500 hover:border-zinc-300 dark:border-zinc-700 dark:text-zinc-400"
              }`}
            >
              {m.caption || m.season || (m.status === "primary" ? "primary" : "alternate")}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
