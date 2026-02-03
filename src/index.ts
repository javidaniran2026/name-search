import { connectDb, closeDb } from "./db";
import { createBot } from "./bot";
import { startWatcher } from "./watcher";
import { importData } from "./importer";

let bot: ReturnType<typeof createBot> | null = null;

const BOT_COMMANDS = [
  { command: "start", description: "خوش آمدید" },
  { command: "help", description: "راهنما" },
];

async function main() {
  await connectDb();

  // Auto-import data on startup
  const { imported, skipped, existing } = await importData();
  console.log(`Import done: ${imported} new, ${existing} existing, ${skipped} skipped`);

  bot = createBot();
  await bot.api.setMyCommands(BOT_COMMANDS);
  startWatcher();
  console.log("Bot started successfully");
  await bot.start();
}

async function shutdown() {
  if (bot) await bot.stop();
  await closeDb();
  process.exit(0);
}

main().catch((err) => {
  console.error("Startup failed:", err);
  process.exit(1);
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
