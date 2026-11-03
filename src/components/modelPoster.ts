// Turn a GLB into a still PNG, in the browser, using the viewer that is already
// a dependency.
//
// The album needs a thumbnail and a GLB has none, so something has to render
// one. Doing it here rather than server-side is the cheap answer: the file has
// just been uploaded from this very tab, <model-viewer> is already installed to
// show it, and a WebGL readback of a loaded scene costs nothing. No render farm,
// no Blender on a serverless function, no second pipeline to keep working.
//
// It is deliberately best-effort. A capture can fail for reasons that have
// nothing to do with the model being fine — no WebGL in this browser, a GPU
// context lost under memory pressure, a cross-origin texture tainting the canvas
// — and none of those should cost the user the upload they just did. Callers
// swallow the rejection; the tile falls back to an icon and
// scripts/push-poster.mjs can supply a render later.

const LOAD_TIMEOUT_MS = 20_000;

// The element has ~80 attributes and two methods that matter here; typing just
// those is honest about what is used, where `any` would hide a real misspelling.
interface PosterableViewer extends HTMLElement {
  src: string;
  loaded?: boolean;
  cameraOrbit?: string;
  toBlob(options?: {
    mimeType?: string;
    qualityArgument?: number;
    idealAspect?: boolean;
  }): Promise<Blob>;
}

export async function captureModelPoster(url: string, size = 512): Promise<Blob> {
  if (typeof window === "undefined") throw new Error("no browser");

  // Imported on use, not at module scope: model-viewer registers a custom
  // element and reaches for `window` as it loads, so a static import breaks the
  // server render of a page where most plants have no model at all.
  await import("@google/model-viewer");

  const el = document.createElement("model-viewer") as PosterableViewer;
  // Off-screen but genuinely laid out. `display: none` or a zero-size box gives
  // the renderer no drawing buffer and toBlob comes back blank — the thumbnail
  // has to be really drawn to be really captured.
  el.style.position = "fixed";
  el.style.left = "-9999px";
  el.style.top = "0";
  el.style.width = `${size}px`;
  el.style.height = `${size}px`;
  el.style.backgroundColor = "transparent";
  // A transparent PNG on a neutral tile, which is the convention the design
  // symbols already set, so the two sections look like one gallery.
  el.setAttribute("exposure", "1");
  el.setAttribute("shadow-intensity", "1");
  el.setAttribute("interaction-prompt", "none");
  // Three-quarter view from slightly above: a plant read head-on loses its
  // habit, which is the one thing a thumbnail of a plant has to show.
  el.setAttribute("camera-orbit", "25deg 75deg auto");
  el.src = url;

  document.body.appendChild(el);
  try {
    await new Promise<void>((resolve, reject) => {
      if (el.loaded) return resolve();
      const timer = window.setTimeout(
        () => reject(new Error("the model did not finish loading")),
        LOAD_TIMEOUT_MS,
      );
      const done = () => {
        window.clearTimeout(timer);
        resolve();
      };
      const fail = () => {
        window.clearTimeout(timer);
        reject(new Error("the model could not be loaded"));
      };
      el.addEventListener("load", done, { once: true });
      el.addEventListener("error", fail, { once: true });
    });

    // One frame after `load` before reading the buffer. The event says the
    // scene is ready, not that it has been painted, and a readback taken in the
    // same tick can come back empty.
    await new Promise<void>((r) => requestAnimationFrame(() => r()));

    return await el.toBlob({ mimeType: "image/png", idealAspect: true });
  } finally {
    el.remove();
  }
}

// Capture a thumbnail and store it against a model. Resolves to the poster URL,
// or null if anything went wrong — by design, so an upload is never undone by a
// thumbnail that would not render.
export async function captureAndSavePoster(
  plantId: number,
  modelId: number,
  modelUrl: string,
): Promise<string | null> {
  try {
    const blob = await captureModelPoster(modelUrl);
    const fd = new FormData();
    fd.append("modelId", String(modelId));
    fd.append("file", new File([blob], "poster.png", { type: "image/png" }));
    const res = await fetch(`/api/plants/${plantId}/models/poster`, { method: "POST", body: fd });
    if (!res.ok) return null;
    const d = (await res.json()) as { posterUrl?: string | null };
    return d.posterUrl ?? null;
  } catch {
    return null;
  }
}
