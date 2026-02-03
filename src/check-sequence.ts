/**
 * Check sequence numbers in each message. Extracts ALL numbers per message
 * (e.g. "۸۲ و ۸۳. ..." → 82,83 and "۲۰۵. امیر / ۲۰۶. امید" → 205,206)
 * Only counts numbers followed by a DOT as sequence numbers (filters out dates/ages).
 * Run: bun run src/check-sequence.ts
 */
import { readFile, access } from "fs/promises";
import { join } from "path";

const DATA_DIR = join(import.meta.dir, "..", "data");
const RESULT_JSON = join(DATA_DIR, "result.json");

const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

type TextPart = string | { type: string; text: string };

function extractPlainText(text: string | TextPart[] | undefined): string {
  if (text == null) return "";
  if (typeof text === "string") return text;
  return text
    .map((part) => (typeof part === "string" ? part : part.text ?? ""))
    .join("");
}

function toWesternDigits(s: string): string {
  return s.replace(/[۰-۹]/g, (c) => String(PERSIAN_DIGITS.indexOf(c)));
}

function parseNum(digitStr: string): number | null {
  const n = parseInt(toWesternDigits(digitStr), 10);
  return Number.isNaN(n) ? null : n;
}

/**
 * Extract sequence numbers from a line. Only numbers followed by a DOT count.
 * Handles: "۱۳۰۰. نام", "۸۲ و ۸۳. نام و نام", "۲۰۵. نام"
 * Ignores: "۲۰ دی ۱۴۰۴" (no dot), "۱۵ ساله" (no dot)
 */
function extractSequenceNumbersFromLine(line: string): number[] {
  const trimmed = line.trim();
  const result: number[] = [];
  const seen = new Set<number>();

  // Pattern: number(s) followed by a dot, e.g. "۱۳۰۰." or "۸۲ و ۸۳."
  // Matches at start of line or after whitespace
  const regex = /(?:^|\s)([۰-۹0-9]+(?:\s*و\s*[۰-۹0-9]+)*)\s*\./g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(trimmed)) !== null) {
    const block = match[1] ?? "";
    const digitRuns = block.match(/[۰-۹0-9]+/g) ?? [];
    for (const run of digitRuns) {
      const n = parseNum(run);
      if (n != null && n >= 1 && n <= 3000 && !seen.has(n)) {
        seen.add(n);
        result.push(n);
      }
    }
  }

  return result.sort((a, b) => a - b);
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

  const raw = await readFile(RESULT_JSON, "utf-8");
  const data: ChannelExport = JSON.parse(raw);
  const messages = data.messages ?? [];

  const numToEntries = new Map<number, { messageId: number; firstLine: string }[]>();
  const noNumber: { messageId: number; firstLine: string }[] = [];
  const allNums: number[] = [];

  for (const msg of messages) {
    if (msg.type !== "message" || !msg.photo) continue;
    const caption = extractPlainText(msg.text).replace(/@\w+/g, "").trim();
    const lines = caption.split("\n").map((l) => l.trim()).filter(Boolean);
    const firstLine = lines[0] ?? "";

    // Extract sequence numbers from ALL lines (multi-person entries may have one per line)
    const seenInMsg = new Set<number>();
    for (const line of lines) {
      for (const num of extractSequenceNumbersFromLine(line)) {
        seenInMsg.add(num);
      }
    }
    const nums = [...seenInMsg].sort((a, b) => a - b);

    if (nums.length === 0) {
      noNumber.push({ messageId: msg.id, firstLine: firstLine.slice(0, 60) });
      continue;
    }
    for (const num of nums) {
      allNums.push(num);
      const list = numToEntries.get(num) ?? [];
      list.push({ messageId: msg.id, firstLine: firstLine.slice(0, 50) });
      numToEntries.set(num, list);
    }
  }

  const duplicates = [...numToEntries.entries()].filter(([, list]) => list.length > 1);
  const minNum = allNums.length > 0 ? Math.min(...allNums) : 0;
  const maxNum = allNums.length > 0 ? Math.max(...allNums) : 0;
  const expected = new Set<number>();
  for (let i = minNum; i <= maxNum; i++) expected.add(i);
  const present = new Set(allNums);
  const gaps = [...expected].filter((n) => !present.has(n)).sort((a, b) => a - b);

  console.log("--- Messages with no leading number (or unparseable) ---");
  console.log(`Count: ${noNumber.length}`);
  if (noNumber.length > 0 && noNumber.length <= 25) {
    noNumber.forEach((x) => console.log(`  messageId=${x.messageId}  firstLine: "${x.firstLine}${x.firstLine.length >= 60 ? "..." : ""}"`));
  } else if (noNumber.length > 25) {
    noNumber.slice(0, 12).forEach((x) => console.log(`  messageId=${x.messageId}  firstLine: "${x.firstLine}..."`));
    console.log(`  ... and ${noNumber.length - 12} more`);
  }

  console.log("\n--- Duplicate sequence numbers (same number in multiple messages) ---");
  console.log(`Count: ${duplicates.length} number(s) used in more than one message`);
  duplicates.forEach(([num, list]) => {
    console.log(`  Number ${num} appears in ${list.length} messages:`);
    list.forEach((e) => console.log(`    messageId=${e.messageId}  "${e.firstLine}..."`));
  });

  console.log("\n--- Gaps (real missing sequence numbers, multi-person entries counted) ---");
  console.log(`Range in data: ${minNum} .. ${maxNum}`);
  console.log(`Missing count: ${gaps.length}`);
  if (gaps.length > 0) {
    if (gaps.length <= 50) {
      console.log(`Missing: ${gaps.join(", ")}`);
    } else {
      console.log(`First 30 missing: ${gaps.slice(0, 30).join(", ")}`);
      console.log(`... and ${gaps.length - 30} more`);
    }
  } else if (gaps.length === 0 && minNum > 0) {
    console.log("(none)");
  }

  const totalImportable = messages.filter((m) => m.type === "message" && m.photo).length;
  console.log("\n--- Summary ---");
  console.log(`Importable messages (message+photo): ${totalImportable}`);
  console.log(`Messages with ≥1 sequence number: ${totalImportable - noNumber.length}`);
  console.log(`Messages with no parseable number: ${noNumber.length}`);
  console.log(`Sequence range: ${minNum} .. ${maxNum}`);
  console.log(`Duplicates (same number in multiple messages): ${duplicates.length}`);
  console.log(`Real gaps: ${gaps.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
