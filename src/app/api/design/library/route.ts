import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";
import { safeExtension } from "@/lib/storagePaths";
import {
  PP_LIBRARY_BUCKET,
  ppLibraryUrl,
  isLibraryKind,
  type LibraryItem,
  type LibraryItemData,
} from "@/lib/design/library";

// The design stamp/plan-symbol library. Both libraries live in one table keyed
// by `kind`. GET returns every row (both kinds); the client filters. POST
// creates one item: the image is uploaded to the pp-library bucket and the row
// keeps only image_path. Item ids are client-generated ('custom-...'/'plan-...').

export async function GET() {
  const { data, error } = await supabase
    .from("pp_library_items")
    .select("id, kind, data, image_path")
    .order("sort_order", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const items: LibraryItem[] = (data ?? []).map((row) => ({
    id: row.id as string,
    kind: row.kind as LibraryItem["kind"],
    data: (row.data ?? {}) as LibraryItemData,
    image_path: (row.image_path as string | null) ?? null,
    imageUrl: row.image_path ? ppLibraryUrl(row.image_path as string) : null,
  }));

  return NextResponse.json({ items });
}

export async function POST(req: NextRequest) {
  // Two ways in. The multipart form (file + fields) is the original and still
  // works for images that fit a serverless body. A JSON body registers an image
  // the browser already uploaded straight to Storage through ./upload-url,
  // which is how images over ~4.5MB get here.
  const isJson = (req.headers.get("content-type") ?? "").includes("application/json");

  let file: File | null = null;
  let id: unknown;
  let kind: unknown;
  let dataRaw: unknown;
  let jsonPath: unknown;

  if (isJson) {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) {
      return NextResponse.json({ error: "a JSON body is required" }, { status: 400 });
    }
    id = body.id;
    kind = body.kind;
    dataRaw = body.data;
    jsonPath = body.image_path;
  } else {
    const form = await req.formData();
    const f = form.get("file");
    if (!(f instanceof File)) {
      return NextResponse.json({ error: "file is required" }, { status: 400 });
    }
    file = f;
    id = form.get("id");
    kind = form.get("kind");
    dataRaw = form.get("data");
  }

  if (typeof id !== "string" || !id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }
  if (typeof kind !== "string" || !isLibraryKind(kind)) {
    return NextResponse.json({ error: "kind must be perspective-stamp or plan-symbol" }, { status: 400 });
  }

  let data: LibraryItemData;
  try {
    data = typeof dataRaw === "string" ? JSON.parse(dataRaw) : ((dataRaw as LibraryItemData) ?? {});
  } catch {
    return NextResponse.json({ error: "data must be valid JSON" }, { status: 400 });
  }

  try {
    let path: string;
    if (file) {
      const ext = safeExtension(file.name, "png");
      path = `${kind}/${id}.${ext}`;

      const { error: uploadError } = await supabase.storage
        .from(PP_LIBRARY_BUCKET)
        .upload(path, file, { contentType: file.type || "image/png", upsert: true });

      if (uploadError) {
        return NextResponse.json({ error: uploadError.message }, { status: 500 });
      }
    } else {
      // The path was minted by ./upload-url as `${kind}/${id}.${ext}`. Re-check
      // it, so a row can't point at some other item's object (a later delete
      // would reclaim someone else's file), and that the bytes really arrived.
      if (typeof jsonPath !== "string" || !new RegExp(`^${kind}/${id}\\.(png|webp|jpg|jpeg)$`).test(jsonPath)) {
        return NextResponse.json({ error: "image_path does not belong to this item" }, { status: 400 });
      }
      path = jsonPath;
      const { data: found, error: listError } = await supabase.storage
        .from(PP_LIBRARY_BUCKET)
        .list(kind, { search: path.slice(kind.length + 1), limit: 1 });
      if (listError || !found?.some((o) => `${kind}/${o.name}` === path)) {
        return NextResponse.json({ error: "the image was not uploaded" }, { status: 400 });
      }
    }

    // Next sort_order for this kind, so items keep their add order.
    const { data: maxRow } = await supabase
      .from("pp_library_items")
      .select("sort_order")
      .eq("kind", kind)
      .order("sort_order", { ascending: false })
      .limit(1)
      .maybeSingle();
    const sortOrder = (maxRow?.sort_order ?? -1) + 1;

    const { data: row, error } = await supabase
      .from("pp_library_items")
      .insert({ id, kind, data, image_path: path, sort_order: sortOrder })
      .select("id, kind, data, image_path")
      .single();

    if (error) {
      await supabase.storage.from(PP_LIBRARY_BUCKET).remove([path]);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const item: LibraryItem = {
      id: row.id as string,
      kind: row.kind as LibraryItem["kind"],
      data: (row.data ?? {}) as LibraryItemData,
      image_path: (row.image_path as string | null) ?? null,
      imageUrl: row.image_path ? ppLibraryUrl(row.image_path as string) : null,
    };

    return NextResponse.json({ item }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to create library item" },
      { status: 500 }
    );
  }
}
