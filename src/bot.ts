import {
  Bot,
  Context,
  InputFile,
  InputMediaBuilder,
  InlineKeyboard,
} from "grammy";
import { join } from "path";
import { existsSync } from "fs";
import { randomBytes } from "crypto";
import { searchAll, PAGE_SIZE } from "./search";
import type { VictimRecord } from "./importer";
import {
  parseForwardCaption,
  getForwardMessageId,
  downloadPhotoAndSave,
  upsertForwardedVictim,
  buildVictimRecord,
} from "./forward";

const DATA_DIR = join(import.meta.dir, "..", "data");
const SESSION_TTL_MS = 60 * 60 * 1000;

interface PaginationSession {
  query: string;
  total: number;
  createdAt: number;
}

const paginationSessions = new Map<string, PaginationSession>();

function createSession(query: string, total: number): string {
  const token = randomBytes(6).toString("hex");
  paginationSessions.set(token, {
    query,
    total,
    createdAt: Date.now(),
  });
  return token;
}

function getSession(token: string): PaginationSession | null {
  const s = paginationSessions.get(token);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL_MS) {
    paginationSessions.delete(token);
    return null;
  }
  return s;
}

function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [token, s] of paginationSessions.entries()) {
    if (now - s.createdAt > SESSION_TTL_MS) paginationSessions.delete(token);
  }
}

const CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

const messages = {
  welcome: `سلام 🕊️

این ربات برای جستجوی نام جاویدنام‌های ایران است.

برای جستجو متن مورد نظرتان را ارسال کنید (نام، مکان، یا تاریخ).

کانال اصلی: @RememberTheirNames`,

  help: `📖 راهنما

هر متنی بفرستید، ربات در نام، شهر و تاریخ جستجو می‌کند.

مثال: علی تهران ۱۹ دی

نکته: املای متفاوت مشکلی ایجاد نمی‌کند.`,

  noResults: (query: string) => `نتیجه‌ای برای «${query}» یافت نشد.`,
  summary: (from: number, to: number, total: number, page: number, pages: number) =>
    `نمایش ${from}–${to} از ${total}. صفحه ${page} از ${pages}`,
  buttonPrev: "صفحه قبل",
  buttonNext: "صفحه بعد",
  error: `متاسفانه خطایی رخ داد. لطفا دوباره تلاش کنید.`,
  sessionExpired: `جستجوی قبلی منقضی شده. لطفا دوباره جستجو کنید.`,
  adminOnly: `این دستور فقط برای ادمین بات است.`,
  forwardSuccess: `اضافه شد.`,
  forwardInvalid: `متن یا عکس نامعتبر است.`,
};

function formatCaption(r: VictimRecord): string {
  const parts = [r.name];
  if (r.date) parts.push(r.date);
  if (r.location) parts.push(r.location);
  return parts.join("\n");
}

export function createBot(): Bot {
  const token = process.env.BOT_TOKEN;
  if (!token) {
    throw new Error("BOT_TOKEN is not set");
  }
  const bot = new Bot(token);

  setInterval(cleanupExpiredSessions, CLEANUP_INTERVAL_MS);

  bot.command("start", (ctx) => ctx.reply(messages.welcome));
  bot.command("help", (ctx) => ctx.reply(messages.help));

  bot.on("message:text", async (ctx) => {
    const query = ctx.message.text.trim();
    if (!query) return;
    await runSearch(ctx, query);
  });

  bot.on("message:photo", async (ctx) => {
    const msg = ctx.message;
    if (!msg.forward_origin || !msg.caption) return;
    const adminId = process.env.ADMIN_ID ? Number(process.env.ADMIN_ID) : 0;
    if (!adminId || ctx.from?.id !== adminId) {
      await ctx.reply(messages.adminOnly).catch(() => {});
      return;
    }
    const parsed = parseForwardCaption(msg.caption);
    if (!parsed) {
      await ctx.reply(messages.forwardInvalid).catch(() => {});
      return;
    }
    const messageId = getForwardMessageId(msg.forward_origin, msg.message_id);
    try {
      const photos = msg.photo;
      const largest = photos[photos.length - 1];
      if (!largest) {
        await ctx.reply(messages.forwardInvalid).catch(() => {});
        return;
      }
      const photoPath = await downloadPhotoAndSave(ctx.api, largest.file_id, messageId);
      const record = buildVictimRecord(
        messageId,
        parsed.name,
        parsed.date,
        parsed.location,
        photoPath,
        msg.caption
      );
      await upsertForwardedVictim(record);
      await ctx.reply(messages.forwardSuccess).catch(() => {});
    } catch {
      await ctx.reply(messages.forwardInvalid).catch(() => {});
    }
  });

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith("p:")) return;
    const parts = data.split(":");
    if (parts.length !== 3) return;
    const sessionToken = parts[1];
    const pageStr = parts[2];
    const page = parseInt(pageStr ?? "", 10);
    if (!sessionToken || isNaN(page) || page < 1) return;
    await ctx.answerCallbackQuery();
    const session = getSession(sessionToken);
    if (!session) {
      await ctx.reply(messages.sessionExpired).catch(() => {});
      return;
    }
    const chatId = ctx.chat?.id ?? ctx.callbackQuery.message?.chat?.id;
    if (chatId == null) return;
    try {
      await sendPage(chatId, session.query, session.total, page, ctx.api, sessionToken);
    } catch {
      await ctx.api.sendMessage(chatId, messages.error).catch(() => {});
    }
  });

  bot.catch((err) => {
    console.error("Bot error:", err.message);
  });

  return bot;
}

async function runSearch(ctx: Context, query: string): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId == null) return;
  try {
    const { results, total } = await searchAll(query, { skip: 0, limit: PAGE_SIZE });
    if (total === 0) {
      await ctx.reply(messages.noResults(query));
      return;
    }
    await sendPage(chatId, query, total, 1, ctx.api, undefined);
  } catch {
    await ctx.reply(messages.error);
  }
}

async function sendPage(
  chatId: number,
  query: string,
  total: number,
  page: number,
  api: Bot["api"],
  existingToken?: string
): Promise<void> {
  const skip = (page - 1) * PAGE_SIZE;
  const { results } = await searchAll(query, { skip, limit: PAGE_SIZE });
  const withPhoto: VictimRecord[] = [];
  const withoutPhoto: VictimRecord[] = [];
  for (const r of results) {
    const photoPath = join(DATA_DIR, r.photoPath);
    if (existsSync(photoPath)) withPhoto.push(r);
    else withoutPhoto.push(r);
  }

  const persianDigits = "۰۱۲۳۴۵۶۷۸۹";
  const toPersianNum = (n: number) =>
    String(n)
      .split("")
      .map((d) => persianDigits[parseInt(d, 10)])
      .join("");

  if (withPhoto.length >= 2) {
    const media = withPhoto.map((r, i) =>
      InputMediaBuilder.photo(new InputFile(join(DATA_DIR, r.photoPath)), {
        caption: `${toPersianNum(skip + i + 1)}. ${formatCaption(r)}`,
      })
    );
    await api.sendMediaGroup(chatId, media);
  } else if (withPhoto.length === 1) {
    const r = withPhoto[0];
    if (r) {
      await api.sendPhoto(chatId, new InputFile(join(DATA_DIR, r.photoPath)), {
        caption: `${toPersianNum(skip + 1)}. ${formatCaption(r)}`,
      });
    }
  }

  if (withoutPhoto.length > 0) {
    const startNum = skip + withPhoto.length + 1;
    const text = withoutPhoto
      .map((r, i) => `${toPersianNum(startNum + i)}. ${formatCaption(r)}`)
      .join("\n\n");
    await api.sendMessage(chatId, text);
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);
  if (totalPages <= 1) return;

  const from = skip + 1;
  const to = skip + results.length;
  const summaryText = messages.summary(from, to, total, page, totalPages);

  const token = existingToken ?? createSession(query, total);
  const keyboard = new InlineKeyboard();
  if (page > 1) keyboard.text(messages.buttonPrev, `p:${token}:${page - 1}`);
  if (page < totalPages) keyboard.text(messages.buttonNext, `p:${token}:${page + 1}`);

  await api.sendMessage(chatId, summaryText, {
    reply_markup: keyboard,
  });
}
