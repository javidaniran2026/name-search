/**
 * Compare result.json to DB and report which messages were skipped or not imported.
 * Run: bun run src/check-skipped.ts
 */
import { readFile, access } from "fs/promises";
import { join } from "path";
import { connectDb, closeDb } from "./db";
import { extractName } from "./importer";

const DATA_DIR = join(import.meta.dir, "..", "data");
const RESULT_JSON = join(DATA_DIR, "result.json");

type TextPart = string | { type: string; text: string };

function extractPlainText(text: string | TextPart[] | undefined): string {
  if (text == null) return "";
  if (typeof text === "string") return text;
  return text
    .map((part) => (typeof part === "string" ? part : part.text ?? ""))
    .join("");
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

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await fileExists(RESULT_JSON))) {
    console.error(`Data file not found: ${RESULT_JSON}`);
    process.exit(1);
  }

  const db = await connectDb();
  const existingIds = new Set(
    (await db.collection("victims").find({}, { projection: { messageId: 1 } }).toArray()).map(
      (d: { messageId: number }) => d.messageId
    )
  );

  const raw = await readFile(RESULT_JSON, "utf-8");
  const data: ChannelExport = JSON.parse(raw);
  const messages = data.messages ?? [];

  const notImportable: ExportMessage[] = [];
  const noName: { id: number; caption: string }[] = [];
  const notInDb: { id: number; name: string }[] = []; // has name but not in DB (e.g. insert failed)

  for (const msg of messages) {
    if (msg.type !== "message" || !msg.photo) {
      notImportable.push(msg);
      continue;
    }
    if (existingIds.has(msg.id)) continue; // in DB, ok

    const caption = extractPlainText(msg.text).replace(/@\w+/g, "").trim();
    const name = extractName(caption);
    if (!name) {
      noName.push({ id: msg.id, caption: caption.slice(0, 80) });
      continue;
    }
    notInDb.push({ id: msg.id, name });
  }

  console.log("--- Not importable (type !== 'message' or no photo) ---");
  console.log(`Count: ${notImportable.length}\n`);
  notImportable.forEach((msg) => {
    console.log(JSON.stringify(msg, null, 2));
    console.log("");
  });

  console.log("\n--- Skipped (no name extracted from first line) ---");
  console.log(`Count: ${noName.length}`);
  if (noName.length > 0 && noName.length <= 20) {
    noName.forEach((x) => console.log(`  id=${x.id} caption: "${x.caption}..."`));
  } else if (noName.length > 20) {
    noName.slice(0, 10).forEach((x) => console.log(`  id=${x.id} caption: "${x.caption}..."`));
    console.log(`  ... and ${noName.length - 10} more`);
  }

  console.log("\n--- Has name but not in DB (likely insert failed) ---");
  console.log(`Count: ${notInDb.length}`);
  if (notInDb.length > 0 && notInDb.length <= 20) {
    notInDb.forEach((x) => console.log(`  id=${x.id} name: ${x.name}`));
  } else if (notInDb.length > 20) {
    notInDb.slice(0, 10).forEach((x) => console.log(`  id=${x.id} name: ${x.name}`));
    console.log(`  ... and ${notInDb.length - 10} more`);
  }

  const inDb = messages.filter((m) => m.type === "message" && m.photo && existingIds.has(m.id)).length;
  console.log("\n--- Summary ---");
  console.log(`JSON messages (total): ${messages.length}`);
  console.log(`Importable (message + photo): ${messages.filter((m) => m.type === "message" && m.photo).length}`);
  console.log(`In DB: ${inDb}`);
  console.log(`Not importable: ${notImportable.length}`);
  console.log(`Skipped (no name): ${noName.length}`);
  console.log(`Not in DB (has name): ${notInDb.length}`);
}

main()
  .then(() => closeDb())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    closeDb().finally(() => process.exit(1));
  });
