import { readFile, access } from "fs/promises";
import { join } from "path";
import { connectDb, ensureIndexes } from "./db";
import { ensureMeiliIndex, indexVictims, type MeiliVictimDoc } from "./meili";
import { normalizeForSearch } from "./normalizer";

const DATA_DIR = join(import.meta.dir, "..", "data");
const RESULT_JSON = join(DATA_DIR, "result.json");

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export interface VictimRecord {
  messageId: number;
  name: string;
  caption: string;
  photoPath: string;
  createdAt: Date;
}

type TextPart = string | { type: string; text: string };

function extractPlainText(text: string | TextPart[] | undefined): string {
  if (text == null) return "";
  if (typeof text === "string") return text;
  return text
    .map((part) => (typeof part === "string" ? part : part.text ?? ""))
    .join("");
}

export function extractName(caption: string): string {
  const firstLine = caption.split("\n")[0]?.trim() ?? "";
  // Strip leading number + optional dot + optional space (handles both "۱۷۰۹. نام" and "۱۷۰۹ نام")
  return firstLine.replace(/^[۰-۹0-9]+\.?\s*/, "").trim();
}

/**
 * Extract all names from a caption (handles multi-person entries).
 * e.g. "۸۲ و ۸۳. منصوره حیدری و بهروز منصوری" → ["منصوره حیدری", "بهروز منصوری"]
 * e.g. "۲۰۵. امیر تیموری راد\n۲۰۶. امید تیموری راد" → ["امیر تیموری راد", "امید تیموری راد"]
 */
export function extractAllNames(caption: string): string[] {
  const lines = caption.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  const names: string[] = [];

  for (const line of lines) {
    // Strip leading "N." or "N و M." or just "N " (handles missing dot)
    const afterNumbers = line.replace(/^[۰-۹0-9\sو\.]+/, "").trim();
    if (!afterNumbers) continue;

    // If contains " و " (and), split into multiple names
    if (afterNumbers.includes(" و ")) {
      const parts = afterNumbers.split(/\s+و\s+/).map((s) => s.trim()).filter(Boolean);
      names.push(...parts);
    } else {
      names.push(afterNumbers);
    }
  }

  // Dedupe while preserving order
  const seen = new Set<string>();
  return names.filter((n) => {
    if (seen.has(n)) return false;
    seen.add(n);
    return true;
  });
}

interface ExportMessage {
  id: number;
  type: string;
  text?: string | TextPart[];
  photo?: string;
}

interface ChannelExport {
  messages?: ExportMessage[];
}

export async function importData(jsonPath: string = RESULT_JSON): Promise<{
  imported: number;
  skipped: number;
  existing: number;
}> {
  const db = await connectDb();
  await ensureIndexes(db);

  // Skip import if data file doesn't exist
  if (!(await fileExists(jsonPath))) {
    console.log(`Data file not found: ${jsonPath}, skipping import`);
    return { imported: 0, skipped: 0, existing: 0 };
  }

  const coll = db.collection<VictimRecord>("victims");

  // Get existing messageIds to skip duplicates
  const existingIds = new Set(
    (await coll.find({}, { projection: { messageId: 1 } }).toArray()).map(
      (doc) => doc.messageId
    )
  );

  const raw = await readFile(jsonPath, "utf-8");
  const data: ChannelExport = JSON.parse(raw);
  const messages = data.messages ?? [];

  let imported = 0;
  let skipped = 0;
  let existing = 0;
  const meiliDocs: MeiliVictimDoc[] = [];

  for (const msg of messages) {
    if (msg.type !== "message" || !msg.photo) {
      skipped++;
      continue;
    }
    // Skip if already in database
    if (existingIds.has(msg.id)) {
      existing++;
      continue;
    }
    const caption = extractPlainText(msg.text).replace(/@\w+/g, "").trim();
    const allNames = extractAllNames(caption);
    const name = allNames[0] ?? extractName(caption);
    if (!name) {
      skipped++;
      continue;
    }
    const record: VictimRecord = {
      messageId: msg.id,
      name,
      caption,
      photoPath: msg.photo,
      createdAt: new Date(),
    };
    try {
      await coll.insertOne(record);
      imported++;
      const nameForSearch = allNames.length > 0 ? allNames.join(" ") : name;
      meiliDocs.push({
        messageId: record.messageId,
        name: normalizeForSearch(nameForSearch),
        caption: normalizeForSearch(caption),
      });
    } catch {
      skipped++;
    }
  }

  if (meiliDocs.length > 0) {
    await ensureMeiliIndex();
    const BATCH = 1000;
    for (let i = 0; i < meiliDocs.length; i += BATCH) {
      await indexVictims(meiliDocs.slice(i, i + BATCH));
    }
  }

  return { imported, skipped, existing };
}

/**
 * Sync all MongoDB records to Meilisearch.
 * Used when Meilisearch is reset/empty but MongoDB has data.
 */
export async function syncToMeilisearch(): Promise<number> {
  const db = await connectDb();
  const coll = db.collection<VictimRecord>("victims");
  const docs = await coll.find({}).toArray();
  if (docs.length === 0) return 0;

  await ensureMeiliIndex();
  const meiliDocs: MeiliVictimDoc[] = docs.map((doc) => {
    const allNames = extractAllNames(doc.caption);
    const nameForSearch = allNames.length > 0 ? allNames.join(" ") : doc.name;
    return {
      messageId: doc.messageId,
      name: normalizeForSearch(nameForSearch),
      caption: normalizeForSearch(doc.caption),
    };
  });

  const BATCH = 1000;
  for (let i = 0; i < meiliDocs.length; i += BATCH) {
    await indexVictims(meiliDocs.slice(i, i + BATCH));
  }

  return docs.length;
}

if (import.meta.main) {
  importData()
    .then(({ imported, skipped, existing }) => {
      console.log(
        `Import done: ${imported} new, ${existing} existing, ${skipped} skipped`
      );
      process.exit(0);
    })
    .catch((err) => {
      console.error("Import failed:", err);
      process.exit(1);
    });
}
