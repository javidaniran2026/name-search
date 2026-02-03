import { join } from "path";
import { mkdirSync, writeFileSync } from "fs";
import { connectDb } from "./db";
import { ensureMeiliIndex, indexVictim } from "./meili";
import { normalizeForSearch } from "./normalizer";
import type { VictimRecord } from "./importer";
import { extractName, extractAllNames } from "./importer";
import type { Api } from "grammy";

const PHOTOS_DIR = join(import.meta.dir, "..", "data", "photos");
const FORWARD_OFFSET = 1_000_000;

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
  const allNames = extractAllNames(record.caption);
  const nameForSearch = allNames.length > 0 ? allNames.join(" ") : record.name;
  await indexVictim({
    messageId: record.messageId,
    name: normalizeForSearch(nameForSearch),
    caption: normalizeForSearch(record.caption),
  });
}

export function buildVictimRecord(
  messageId: number,
  caption: string,
  photoPath: string
): VictimRecord {
  const raw = caption.replace(/@\w+/g, "").trim();
  const allNames = extractAllNames(raw);
  const name = allNames[0] ?? extractName(raw);
  if (!name) throw new Error("Caption has no name");
  return {
    messageId,
    name,
    caption: raw,
    photoPath,
    createdAt: new Date(),
  };
}
