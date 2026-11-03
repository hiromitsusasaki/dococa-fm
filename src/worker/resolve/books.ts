import { fetchJson, yearOf } from "./http";
import type { ItemDraft } from "./index";

type Volume = {
  id?: string;
  volumeInfo?: {
    title?: string;
    authors?: string[];
    publishedDate?: string;
    imageLinks?: { thumbnail?: string };
    industryIdentifiers?: Array<{ type?: string; identifier?: string }>;
    infoLink?: string;
  };
};

const ISBN_PATTERN = /^(?:\d{9}[\dXx]|\d{13})$/;

function toDraft(v: Volume): ItemDraft | null {
  const info = v.volumeInfo;
  if (!v.id || !info?.title) return null;
  const ids = info.industryIdentifiers ?? [];
  const isbn = (ids.find((i) => i.type === "ISBN_13") ?? ids.find((i) => i.type === "ISBN_10"))?.identifier;
  return {
    kind: "book",
    title: info.title,
    creator: info.authors?.[0] ?? "",
    year: yearOf(info.publishedDate),
    imageUrl: info.imageLinks?.thumbnail?.replace(/^http:/, "https:") ?? null,
    previewUrl: null,
    outLinks: info.infoLink ? { "google-books": info.infoLink.replace(/^http:/, "https:") } : {},
    externalIds: { "google-books": v.id, ...(isbn ? { isbn } : {}) },
  };
}

export async function searchBooks(text: string): Promise<ItemDraft[]> {
  const compact = text.replace(/[-\s]/g, "");
  const q = ISBN_PATTERN.test(compact) ? `isbn:${compact}` : text;
  const body = await fetchJson<{ items?: Volume[] }>(
    `https://www.googleapis.com/books/v1/volumes?${new URLSearchParams({ q, maxResults: "5" })}`,
  );
  return (body?.items ?? []).flatMap((v) => toDraft(v) ?? []);
}
