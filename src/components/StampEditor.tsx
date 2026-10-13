"use client";

import { useEffect, useRef, useState } from "react";
import { X, Upload, Trash2, Loader2, Shapes, Search } from "lucide-react";
import type { Plant } from "@/lib/plants";
import {
  STAMP_CATEGORIES,
  stampCategoryForPlant,
  type LibraryItem,
  type LibraryItemData,
  type LibraryKind,
} from "@/lib/design/library";
import { ReferencePlantPicker } from "@/components/ReferencePlantPicker";

// Vercel rejects request bodies over ~4.5MB before the route runs. Symbols are
// not run through compressImage: it re-encodes to JPEG, and a symbol is only
// useful with its transparency intact.
const MAX_BYTES = 4_000_000;

interface Link {
  id: number;
  name: string;
  common: string | null;
  category: string | null;
}

function linkFromPlant(p: Plant): Link {
  return { id: p.id, name: p.botanical ?? p.common ?? "Unnamed", common: p.common, category: p.category };
}

function fileStem(name: string): string {
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? name.slice(0, dot) : name).trim();
}

function readDimensions(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      reject(new Error("That file could not be read as an image."));
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });
}

// Add or edit one design library symbol (2D plan symbol or perspective stamp).
// A new item uploads its image through POST /api/design/library; an existing
// one only changes its metadata, because the image is immutable for an id.
// The PATCH replaces the whole `data` document, so edits are merged over the
// item's existing data -- fields this form does not show (defaultScale,
// createdAt, the natural size) survive a save.
export function StampEditor({
  item,
  albumPlants,
  onClose,
  onSaved,
  onDeleted,
}: {
  item: LibraryItem | null; // null = add a new symbol
  albumPlants: Plant[]; // cultivars in the drilled album, offered as the link
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const isNew = item === null;
  const firstPlant = albumPlants.find((p) => p.is_choice) ?? albumPlants[0];

  const [kind, setKind] = useState<LibraryKind>(item?.kind ?? "plan-symbol");
  const [link, setLink] = useState<Link | null>(() => {
    if (item) {
      return item.data.referencePlantId
        ? { id: item.data.referencePlantId, name: item.data.referencePlantName ?? "Linked plant", common: null, category: null }
        : null;
    }
    return firstPlant ? linkFromPlant(firstPlant) : null;
  });
  const [name, setName] = useState(item?.data.name ?? "");
  const [category, setCategory] = useState(item?.data.category ?? stampCategoryForPlant(firstPlant?.category));
  // An existing item shows only what it has; the album's plant seeds a new one.
  const [botanicalName, setBotanicalName] = useState((item ? item.data.botanicalName : firstPlant?.botanical) ?? "");
  const [commonName, setCommonName] = useState((item ? item.data.commonName : firstPlant?.common) ?? "");
  const [notes, setNotes] = useState(item?.data.notes ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // The chosen file's preview URL is made when the file is chosen; release the
  // previous one then, and the last one when the dialog closes.
  useEffect(() => {
    if (!preview) return;
    return () => URL.revokeObjectURL(preview);
  }, [preview]);

  // An item filed under a device-local custom subcategory keeps it as an option,
  // so opening and saving it does not silently move it.
  const categoryOptions = STAMP_CATEGORIES.some((c) => c.id === category)
    ? STAMP_CATEGORIES
    : [...STAMP_CATEGORIES, { id: category, label: `${category} (custom)`, group: "Custom" }];

  const onFile = async (f: File) => {
    setError(null);
    if (!/^image\/(png|webp|jpeg)$/.test(f.type)) {
      setError("Use a PNG or WebP (transparent), or a JPEG.");
      return;
    }
    if (f.size > MAX_BYTES) {
      setError(`That image is ${(f.size / 1_000_000).toFixed(1)}MB; the limit is 4MB.`);
      return;
    }
    try {
      setSize(await readDimensions(f));
      setFile(f);
      setPreview(URL.createObjectURL(f));
      if (!name.trim() && !link) setName(fileStem(f.name));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read image");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  // Choosing a plant carries its names into the symbol, the way the design
  // tool's plant table shows them, and a fresh symbol takes its category too.
  const choosePlant = (p: Plant) => {
    setLink(linkFromPlant(p));
    setBotanicalName(p.botanical ?? "");
    setCommonName(p.common ?? "");
    if (isNew) setCategory(stampCategoryForPlant(p.category));
    setPicking(false);
  };

  const save = async () => {
    setError(null);
    if (isNew && (!file || !size)) {
      setError("Add an image for this symbol.");
      return;
    }
    const edits: Partial<LibraryItemData> = {
      name: name.trim() || link?.name || botanicalName.trim() || "Symbol",
      category,
      botanicalName: botanicalName.trim() || undefined,
      commonName: commonName.trim() || undefined,
      notes: notes.trim() || undefined,
      referencePlantId: link?.id,
      referencePlantName: link?.name,
    };
    setSaving(true);
    try {
      let res: Response;
      if (isNew) {
        const data: LibraryItemData = {
          ...edits,
          name: edits.name!,
          category,
          naturalWidth: size!.width,
          naturalHeight: size!.height,
          createdAt: Date.now(),
        };
        // Same id shapes the design tool mints, so it cannot tell the difference.
        const id = `${kind === "plan-symbol" ? "plan" : "custom"}-${crypto.randomUUID()}`;
        const fd = new FormData();
        fd.append("file", file!);
        fd.append("id", id);
        fd.append("kind", kind);
        fd.append("data", JSON.stringify(data));
        res = await fetch("/api/design/library", { method: "POST", body: fd });
      } else {
        res = await fetch(`/api/design/library/${encodeURIComponent(item!.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data: { ...item!.data, ...edits } }),
        });
      }
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `Save failed (${res.status})`);
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
      setSaving(false);
    }
  };

  const del = async () => {
    if (isNew) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/design/library/${encodeURIComponent(item!.id)}`, { method: "DELETE" });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `Delete failed (${res.status})`);
      }
      onDeleted();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
      setSaving(false);
    }
  };

  const imageSrc = isNew ? preview : item!.imageUrl;
  const inAlbum = link && albumPlants.some((p) => p.id === link.id);
  const fieldClass =
    "rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-sm text-zinc-900 outline-none focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-zinc-100 px-5 py-3 dark:border-zinc-800">
          <div className="flex items-center gap-2">
            <Shapes size={16} className="text-indigo-600" />
            <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
              {isNew ? "Add design symbol" : "Edit design symbol"}
            </h2>
          </div>
          <button onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <X size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {/* Image */}
          <div className="mb-5 flex items-center gap-4">
            <div className="flex h-28 w-28 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-zinc-200 bg-zinc-50 p-2 dark:border-zinc-800 dark:bg-zinc-950">
              {imageSrc ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={imageSrc} alt="" className="max-h-full max-w-full object-contain" />
              ) : (
                <Shapes size={28} className="text-zinc-300 dark:text-zinc-600" />
              )}
            </div>
            <div className="flex flex-col gap-2">
              {isNew ? (
                <>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/png,image/webp,image/jpeg"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) onFile(f);
                    }}
                  />
                  <button
                    onClick={() => fileRef.current?.click()}
                    className="inline-flex items-center gap-1.5 self-start rounded-full bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
                  >
                    <Upload size={15} /> {file ? "Change image" : "Choose image"}
                  </button>
                  <p className="text-xs text-zinc-400">
                    A transparent PNG or WebP, up to 4MB.
                    {size && ` ${size.width} × ${size.height}px.`}
                  </p>
                </>
              ) : (
                <p className="text-xs text-zinc-400">
                  The image can&apos;t be replaced. To use a different one, delete this symbol and add a new one.
                </p>
              )}
            </div>
          </div>

          {/* Kind -- fixed once created: it decides which library the design tool files it in. */}
          <div className="mb-5">
            <span className="mb-1 block text-xs text-zinc-500 dark:text-zinc-400">Kind</span>
            <div className="inline-flex rounded-full bg-zinc-100 p-0.5 dark:bg-zinc-800">
              {(
                [
                  ["plan-symbol", "2D plan"],
                  ["perspective-stamp", "Perspective"],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => isNew && setKind(k)}
                  disabled={!isNew}
                  className={`rounded-full px-3 py-1 text-sm transition-colors disabled:cursor-default ${
                    kind === k
                      ? "bg-white font-medium text-zinc-900 shadow-sm dark:bg-zinc-950 dark:text-zinc-100"
                      : "text-zinc-500 hover:text-zinc-800 disabled:hover:text-zinc-500 dark:text-zinc-400 dark:hover:text-zinc-200"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Linked plant */}
          <div className="mb-5">
            <span className="mb-1 block text-xs text-zinc-500 dark:text-zinc-400">Plant</span>
            <div className="flex flex-wrap items-center gap-2">
              {albumPlants.length > 0 && (
                <select
                  value={link ? String(link.id) : ""}
                  onChange={(e) => {
                    const p = albumPlants.find((x) => String(x.id) === e.target.value);
                    if (p) choosePlant(p);
                    else setLink(null);
                  }}
                  className={`${fieldClass} min-w-0 max-w-full flex-1 italic`}
                >
                  <option value="">Not linked</option>
                  {link && !inAlbum && <option value={String(link.id)}>{link.name}</option>}
                  {albumPlants.map((p) => (
                    <option key={p.id} value={String(p.id)}>
                      {p.botanical || p.common || "Unnamed"}
                    </option>
                  ))}
                </select>
              )}
              {albumPlants.length === 0 && (
                <span className="text-sm italic text-zinc-700 dark:text-zinc-200">{link?.name ?? "Not linked"}</span>
              )}
              <button
                onClick={() => setPicking(true)}
                className="inline-flex items-center gap-1 rounded-full border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
              >
                <Search size={13} /> Other plant…
              </button>
            </div>
            {link && !inAlbum && albumPlants.length > 0 && (
              <p className="mt-1 text-xs text-zinc-400">This plant is outside this album, so the symbol will show in that plant&apos;s album instead.</p>
            )}
          </div>

          {/* Name, category, plant names, notes */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-zinc-500 dark:text-zinc-400">Name</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={link?.name ?? "e.g. Red maple — plan"}
                className={fieldClass}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-zinc-500 dark:text-zinc-400">Design tool category</span>
              <select value={category} onChange={(e) => setCategory(e.target.value)} className={fieldClass}>
                {categoryOptions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.group === c.label ? c.label : `${c.group} › ${c.label}`}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-zinc-500 dark:text-zinc-400">Botanical name</span>
              <input type="text" value={botanicalName} onChange={(e) => setBotanicalName(e.target.value)} className={`${fieldClass} italic`} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-zinc-500 dark:text-zinc-400">Common name</span>
              <input type="text" value={commonName} onChange={(e) => setCommonName(e.target.value)} className={fieldClass} />
            </label>
            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className="text-xs text-zinc-500 dark:text-zinc-400">Notes</span>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={fieldClass} />
            </label>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-zinc-100 px-5 py-3 dark:border-zinc-800">
          <div className="flex min-w-0 items-center gap-3">
            {!isNew && (
              <button
                onClick={del}
                onBlur={() => setConfirmDelete(false)}
                disabled={saving}
                className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${
                  confirmDelete
                    ? "bg-red-600 text-white hover:bg-red-700"
                    : "text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
                }`}
                title="Designs that already use this symbol will lose it"
              >
                <Trash2 size={15} /> {confirmDelete ? "Delete for good?" : "Delete"}
              </button>
            )}
            <span className="truncate text-xs text-red-600 dark:text-red-400">{error}</span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={onClose}
              className="rounded-full px-4 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="inline-flex items-center gap-1.5 rounded-full bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {saving && <Loader2 size={15} className="animate-spin" />}
              {isNew ? "Add symbol" : "Save changes"}
            </button>
          </div>
        </div>
      </div>

      {picking && (
        <div onClick={(e) => e.stopPropagation()}>
          <ReferencePlantPicker currentName={link?.name} onClose={() => setPicking(false)} onPick={choosePlant} />
        </div>
      )}
    </div>
  );
}
