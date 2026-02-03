import { join } from "path";
import { mkdirSync, writeFileSync } from "fs";
import { connectDb } from "./db";
import { ensureMeiliIndex, indexVictim } from "./meili";
import { normalize, normalizeForSearch } from "./normalizer";
import type { VictimRecord } from "./importer";
import type { Api } from "grammy";

const DATA_DIR = join(import.meta.dir, "..", "data");
const PHOTOS_DIR = join(DATA_DIR, "photos");
const FORWARD_OFFSET = 1_000_000;

const PERSIAN_MONTHS =
  "فروردین|اردیبهشت|خرداد|تیر|مرداد|شهریور|مهر|آبان|آذر|دی|بهمن|اسفند";
const DATE_REGEX = new RegExp(
  `([۰-۹0-9]+\\s+${PERSIAN_MONTHS}\\s+[۰-۹0-9]+)`,
  "u"
);

/** Same logic as importer parseCaption: handles extra lines (@mention, blanks), finds date line and name. */
export function parseForwardCaption(caption: string): {
  name: string;
  date: string;
  location: string;
} | null {
  const raw = caption.replace(/@\w+/g, "").trim();
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

  if (!name || !date) return null;
  return { name, date, location };
}

export function getForwardMessageId(
  forwardOrigin: { type: string; message_id?: number } | undefined,
  fallbackMessageId: number
): number {
  if (forwardOrigin?.type === "channel" && typeof forwardOrigin.message_id === "number") {
    return forwardOrigin.message_id;
  }
  return FORWARD_OFFSET + fallbackMessageId;
}

/** Format like original export: photo_<id>@DD-MM-YYYY_HH-MM-SS.jpg */
function exportStylePhotoBasename(messageId: number): string {
  const d = new Date();
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  const seconds = String(d.getSeconds()).padStart(2, "0");
  return `photo_${messageId}@${day}-${month}-${year}_${hours}-${minutes}-${seconds}.jpg`;
}

export async function downloadPhotoAndSave(
  api: Api,
  fileId: string,
  messageId: number
): Promise<string> {
  const file = await api.getFile(fileId);
  const filePath = file.file_path;
  if (!filePath) throw new Error("No file_path");
  const botToken = process.env.BOT_TOKEN;
  if (!botToken) throw new Error("BOT_TOKEN not set");
  const url = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Download failed");
  const buf = await res.arrayBuffer();
  mkdirSync(PHOTOS_DIR, { recursive: true });
  const baseName = exportStylePhotoBasename(messageId);
  const destPath = join(PHOTOS_DIR, baseName);
  writeFileSync(destPath, Buffer.from(buf));
  return `photos/${baseName}`;
}

export async function upsertForwardedVictim(record: VictimRecord): Promise<void> {
  const db = await connectDb();
  const coll = db.collection<VictimRecord>("victims");
  await coll.updateOne(
    { messageId: record.messageId },
    { $set: record },
    { upsert: true }
  );
  await ensureMeiliIndex();
  await indexVictim({
    messageId: record.messageId,
    name: normalizeForSearch(record.name),
    location: normalizeForSearch(record.location),
    date: record.date,
  });
}

export function buildVictimRecord(
  messageId: number,
  name: string,
  date: string,
  location: string,
  photoPath: string,
  originalText: string
): VictimRecord {
  return {
    messageId,
    name,
    normalizedName: normalize(name),
    date,
    location,
    normalizedLocation: normalize(location),
    photoPath,
    originalText,
    createdAt: new Date(),
  };
}
