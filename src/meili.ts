import { Meilisearch } from "meilisearch";

const MEILI_URL = process.env.MEILI_URL ?? "http://localhost:7700";
const MEILI_MASTER_KEY = process.env.MEILI_MASTER_KEY;

let client: Meilisearch | null = null;

export function getMeiliClient(): Meilisearch {
  if (!client) {
    client = new Meilisearch({
      host: MEILI_URL,
      ...(MEILI_MASTER_KEY && { apiKey: MEILI_MASTER_KEY }),
    });
  }
  return client;
}

export const VICTIMS_INDEX = "victims";

export interface MeiliVictimDoc {
  messageId: number;
  name: string;
  location: string;
  date: string;
}

export async function ensureMeiliIndex(): Promise<void> {
  const meili = getMeiliClient();
  const index = meili.index(VICTIMS_INDEX);
  await index.updateSearchableAttributes(["name", "location", "date"]);
  await index.updateTypoTolerance({
    enabled: true,
    minWordSizeForTypos: { oneTypo: 2, twoTypos: 4 },
  });
}

export async function indexVictims(docs: MeiliVictimDoc[]): Promise<void> {
  if (docs.length === 0) return;
  const meili = getMeiliClient();
  const index = meili.index(VICTIMS_INDEX);
  const withId = docs.map((d) => ({ ...d, id: String(d.messageId) }));
  await index.addDocuments(withId, { primaryKey: "id" });
}

export async function indexVictim(doc: MeiliVictimDoc): Promise<void> {
  const meili = getMeiliClient();
  const index = meili.index(VICTIMS_INDEX);
  await index.addDocuments([{ ...doc, id: String(doc.messageId) }], {
    primaryKey: "id",
  });
}

export async function deleteVictimFromIndex(messageId: number): Promise<void> {
  const meili = getMeiliClient();
  const index = meili.index(VICTIMS_INDEX);
  await index.deleteDocument(String(messageId));
}
