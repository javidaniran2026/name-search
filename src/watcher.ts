import { watch } from "fs";
import { join } from "path";
import { importData } from "./importer";

const DATA_DIR = join(import.meta.dir, "..", "data");
const RESULT_JSON = join(DATA_DIR, "result.json");

export function startWatcher(): void {
  watch(RESULT_JSON, async (event, filename) => {
    if (event !== "change" || !filename) return;
    try {
      const { imported, skipped } = await importData(RESULT_JSON);
      if (imported > 0) {
        console.log(`Reimported: ${imported} new, ${skipped} skipped`);
      }
    } catch (err) {
      console.error("Reimport failed:", err instanceof Error ? err.message : err);
    }
  });
}
