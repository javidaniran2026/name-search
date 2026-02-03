import { connectDb } from "./db";
import { getMeiliClient, VICTIMS_INDEX } from "./meili";
import { normalizeForSearch } from "./normalizer";
import type { VictimRecord } from "./importer";

export const PAGE_SIZE = 10;

export interface SearchOptions {
  skip?: number;
  limit?: number;
}

/**
 * Search via Meilisearch: fuzzy, typo-tolerant, across name and full caption.
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
    matchingStrategy: "all",
    rankingScoreThreshold: 0.6,
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
