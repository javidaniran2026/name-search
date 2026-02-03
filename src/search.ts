import { connectDb } from "./db";
import { getMeiliClient, VICTIMS_INDEX } from "./meili";
import { normalize, normalizeForSearch } from "./normalizer";
import type { VictimRecord } from "./importer";

export const PAGE_SIZE = 10;

export interface SearchOptions {
  skip?: number;
  limit?: number;
}

function escapeRegex(s: string): string {
  return s.replace(/[\\^$.*+?()|[\]{}]/g, "\\$&");
}

export async function searchByName(
  query: string,
  opts: SearchOptions = {}
): Promise<{ results: VictimRecord[]; total: number }> {
  const { skip = 0, limit = PAGE_SIZE } = opts;
  const q = query.trim();
  if (!q) return { results: [], total: 0 };
  const normalized = normalize(q);
  const escaped = escapeRegex(normalized);
  const regex = new RegExp(escaped, "u");
  const db = await connectDb();
  const coll = db.collection<VictimRecord>("victims");
  const total = await coll.countDocuments({ normalizedName: regex });
  const results = await coll
    .find({ normalizedName: regex })
    .skip(skip)
    .limit(limit)
    .toArray();
  return { results, total };
}

export async function searchByLocation(
  query: string,
  opts: SearchOptions = {}
): Promise<{ results: VictimRecord[]; total: number }> {
  const { skip = 0, limit = PAGE_SIZE } = opts;
  const q = query.trim();
  if (!q) return { results: [], total: 0 };
  const normalized = normalize(q);
  const escaped = escapeRegex(normalized);
  const regex = new RegExp(escaped, "u");
  const db = await connectDb();
  const coll = db.collection<VictimRecord>("victims");
  const total = await coll.countDocuments({ normalizedLocation: regex });
  const results = await coll
    .find({ normalizedLocation: regex })
    .skip(skip)
    .limit(limit)
    .toArray();
  return { results, total };
}

export async function searchByDate(
  query: string,
  opts: SearchOptions = {}
): Promise<{ results: VictimRecord[]; total: number }> {
  const { skip = 0, limit = PAGE_SIZE } = opts;
  const q = query.trim();
  if (!q) return { results: [], total: 0 };
  const escaped = escapeRegex(q);
  const regex = new RegExp(escaped, "u");
  const db = await connectDb();
  const coll = db.collection<VictimRecord>("victims");
  const total = await coll.countDocuments({ date: regex });
  const results = await coll
    .find({ date: regex })
    .skip(skip)
    .limit(limit)
    .toArray();
  return { results, total };
}

/**
 * Unified search via Meilisearch: fuzzy, typo-tolerant, OR across name, location, date.
 * Fetches full records from MongoDB for photo paths and display.
 */
export async function searchAll(
  query: string,
  opts: SearchOptions = {}
): Promise<{ results: VictimRecord[]; total: number }> {
  const { skip = 0, limit = PAGE_SIZE } = opts;
  const q = query.trim();
  if (!q) return { results: [], total: 0 };

  const meili = getMeiliClient();
  const index = meili.index(VICTIMS_INDEX);
  const searchQuery = normalizeForSearch(q);
  const resp = await index.search(searchQuery, {
    limit,
    offset: skip,
    attributesToRetrieve: ["messageId"],
  });

  const total = resp.estimatedTotalHits ?? 0;
  const messageIds = (resp.hits as { id?: string; messageId?: number }[]).map(
    (h) => (h.messageId != null ? h.messageId : Number(h.id))
  );
  if (messageIds.length === 0) return { results: [], total };

  const db = await connectDb();
  const coll = db.collection<VictimRecord>("victims");
  const cursor = coll.find({ messageId: { $in: messageIds } });
  const byId = new Map<number, VictimRecord>();
  for await (const doc of cursor) {
    byId.set(doc.messageId, doc);
  }
  const results = messageIds
    .map((id) => byId.get(id))
    .filter((r): r is VictimRecord => r != null);

  return { results, total };
}
