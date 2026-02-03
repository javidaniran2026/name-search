import { readFile, access } from "fs/promises";
import { join } from "path";
import { connectDb, ensureIndexes } from "./db";
import { ensureMeiliIndex, indexVictims, type MeiliVictimDoc } from "./meili";
import { normalize, normalizeForSearch } from "./normalizer";

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
  normalizedName: string;
  date: string;
  location: string;
  normalizedLocation: string;
  photoPath: string;
  originalText: string;
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

const PERSIAN_MONTHS =
  "فروردین|اردیبهشت|خرداد|تیر|مرداد|شهریور|مهر|آبان|آذر|دی|بهمن|اسفند";
const DATE_REGEX = new RegExp(
  `([۰-۹0-9]+\\s+${PERSIAN_MONTHS}\\s+[۰-۹0-9]+)`,
  "u"
);

function parseCaption(fullText: string): {
  name: string;
  date: string;
  location: string;
} {
  const raw = fullText.replace(/@\w+/g, "").trim();
  const lines = raw.split(/\n/).map((l) => l.trim()).filter(Boolean);

  let name = "";
  let date = "";
  let location = "";

  for (const line of lines) {
    const withoutNumber = line.replace(/^[۰-۹0-9]+\.\s*/, "").trim();
    const dateMatch = line.match(DATE_REGEX);
    const dateStr = dateMatch?.[1];
    if (dateStr) {
      date = dateStr.trim();
      const rest = line.slice(line.indexOf(dateStr) + dateStr.length).trim();
      if (rest) location = rest;
      break;
    }
    if (withoutNumber && !name) name = withoutNumber;
  }

  const firstLine = lines[0];
  if (!name && firstLine !== undefined) {
    name = firstLine.replace(/^[۰-۹0-9]+\.\s*/, "").trim();
  }

  return { name, date, location };
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
    const fullText = extractPlainText(msg.text);
    const { name, date, location } = parseCaption(fullText);
    if (!name) {
      skipped++;
      continue;
    }
    const record: VictimRecord = {
      messageId: msg.id,
      name,
      normalizedName: normalize(name),
      date,
      location,
      normalizedLocation: normalize(location),
      photoPath: msg.photo,
      originalText: fullText,
      createdAt: new Date(),
    };
    try {
      await coll.insertOne(record);
      imported++;
      meiliDocs.push({
        messageId: record.messageId,
        name: normalizeForSearch(name),
        location: normalizeForSearch(location),
        date,
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
