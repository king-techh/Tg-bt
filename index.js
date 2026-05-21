/**
 * ╔═══════════════════════════════════════════════╗
 * ║     🛡️  SHIELDGUARD BOT v2.0 — PREMIUM     ║
 * ║     Telegram Group Protection Engine         ║
 * ╚═══════════════════════════════════════════════╝
 *
 * Features:
 *   🔗 Anti-Link (Telegram, WhatsApp, all URLs)
 *   🚫 Anti-@Mention (username tags)
 *   📸 Anti-Photo (delete photos from non-admins)
 *   ↔️ Anti-Forward (delete forwarded messages)
 *   🌊 Anti-Flood (rate limit messages)
 *   🎭 Anti-Sticker/Animation spam
 *   ⚠️ Warn System (3 warns = ban)
 *   🎉 Premium Welcome Messages (5 templates)
 *   🟢 Auto-activate when bot becomes admin
 *   ⚙️ /settings to toggle features
 *   📊 /stats for group stats
 *   🏥 HTTP health server for Render deployment
 */

const { Bot, InlineKeyboard } = require("grammy");
const http = require("http");
const fs = require("fs");
const path = require("path");

// ─── Configuration ────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;
const MAX_WARNS = 3;
const FLOOD_LIMIT = 5;
const FLOOD_WINDOW = 5000;
const DATA_FILE = path.join(__dirname, "bot_data.json");

if (!BOT_TOKEN) {
  console.error("❌ FATAL: BOT_TOKEN environment variable is not set!");
  console.error("   Set it in Render → Environment → BOT_TOKEN = your_token_from_BotFather");
  console.error("   Starting HTTP server anyway so Render doesn't crash...");
  startHealthServer();
  return;
}

// ─── Admin Cache (speed boost — avoids repeated API calls) ────────────────────

const adminCache = new Map();
const ADMIN_CACHE_TTL = 30000; // 30 seconds

function cacheKey(chatId, userId) { return `${chatId}:${userId}`; }

function getCachedAdmin(chatId, userId) {
  const k = cacheKey(chatId, userId);
  const entry = adminCache.get(k);
  if (entry && Date.now() - entry.time < ADMIN_CACHE_TTL) return entry.value;
  adminCache.delete(k);
  return null;
}

function setCachedAdmin(chatId, userId, value) {
  adminCache.set(cacheKey(chatId, userId), { value, time: Date.now() });
}

// ─── Persistent Data Store ────────────────────────────────────────────────────

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  } catch (e) { console.error("Data load error:", e.message); }
  return { warns: {}, groups: {}, stats: {}, flood: {} };
}

let store = loadData();
let saveTimer = null;

function save() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(store)); } catch (e) { console.error("Save error:", e.message); }
  }, 2000);
}

// ─── Group Settings ───────────────────────────────────────────────────────────

function defaultGroup() {
  return {
    anti_link: true, anti_mention: true, anti_photo: true,
    anti_forward: true, anti_flood: true, anti_sticker: false,
    welcome_enabled: true, welcome_text: "default", active: false,
  };
}

function getGroup(chatId) {
  const cid = String(chatId);
  if (!store.groups[cid]) { store.groups[cid] = defaultGroup(); save(); }
  return store.groups[cid];
}

function updateGroup(chatId, key, value) {
  getGroup(chatId)[key] = value;
  save();
}

// ─── Warns ────────────────────────────────────────────────────────────────────

function getWarns(chatId, userId) {
  return (store.warns[String(chatId)] && store.warns[String(chatId)][String(userId)]) || 0;
}

function addWarn(chatId, userId) {
  const cid = String(chatId), uid = String(userId);
  if (!store.warns[cid]) store.warns[cid] = {};
  store.warns[cid][uid] = (store.warns[cid][uid] || 0) + 1;
  save();
  return store.warns[cid][uid];
}

function resetWarns(chatId, userId) {
  const cid = String(chatId), uid = String(userId);
  if (store.warns[cid]) { store.warns[cid][uid] = 0; save(); }
}

// ─── Stats ────────────────────────────────────────────────────────────────────

function bumpStat(chatId, key) {
  const cid = String(chatId);
  if (!store.stats[cid]) store.stats[cid] = { deletes: 0, warns: 0, bans: 0, welcomes: 0 };
  store.stats[cid][key] = (store.stats[cid][key] || 0) + 1;
  save();
}

// ─── Flood ────────────────────────────────────────────────────────────────────

function checkFlood(chatId, userId) {
  const cid = String(chatId), uid = String(userId), now = Date.now();
  if (!store.flood[cid]) store.flood[cid] = {};
  if (!store.flood[cid][uid]) store.flood[cid][uid] = [];
  store.flood[cid][uid] = store.flood[cid][uid].filter(t => now - t < FLOOD_WINDOW);
  store.flood[cid][uid].push(now);
  return store.flood[cid][uid].length > FLOOD_LIMIT;
}

// ─── Detection ────────────────────────────────────────────────────────────────

const LINK_TESTS = [
  /https?:\/\//i,
  /t\.me\//i,
  /telegram\.(me|dog)\//i,
  /wa\.me\//i,
  /whatsapp\.com/i,
  /chat\.whatsapp\.com/i,
];

const MENTION_RE = /@[\w]{5,32}/;

function hasLink(t) { return t ? LINK_TESTS.some(r => r.test(t)) : false; }
function hasMention(t) { return t ? MENTION_RE.test(t) : false; }

// ─── Bot + Admin Check ────────────────────────────────────────────────────────

const bot = new Bot(BOT_TOKEN);

async function isAdmin(chatId, userId) {
  const cached = getCachedAdmin(chatId, userId);
  if (cached !== null) return cached;
  try {
    const m = await bot.api.getChatMember(chatId, userId);
    const result = m.status === "administrator" || m.status === "creator";
    setCachedAdmin(chatId, userId, result);
    return result;
  } catch (e) { return false; }
}

// ─── MarkdownV2 Escape ────────────────────────────────────────────────────────

function esc(t) {
  return t ? t.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1") : "";
}

// ─── Warn + Ban ───────────────────────────────────────────────────────────────

async function warnUser(chatId, user, reason) {
  const n = addWarn(chatId, user.id);
  bumpStat(chatId, "warns");
  const left = MAX_WARNS - n;

  if (n >= MAX_WARNS) {
    try {
      await bot.api.banChatMember(chatId, user.id);
      bumpStat(chatId, "bans");
      resetWarns(chatId, user.id);
      await bot.api.sendMessage(chatId,
        `🚫 ═══════════════════════════\n` +
        `*BAN HAMMER STRUCK*\n` +
        `═══════════════════════════\n\n` +
        `👤 User: ${esc(user.first_name)}\n` +
        `💀 Reached ${MAX_WARNS}/${MAX_WARNS} warnings\n` +
        `📌 Last reason: ${esc(reason)}\n\n` +
        `_They have been removed from the group._`,
        { parse_mode: "MarkdownV2" }
      );
      return true;
    } catch (e) {
      console.error("Ban failed:", e.message);
      await bot.api.sendMessage(chatId, `⚠️ Ban failed — check my permissions. User at ${n}/${MAX_WARNS} warns.`);
      return false;
    }
  } else {
    const warnBar = "🔴".repeat(n) + "⚪".repeat(left);
    await bot.api.sendMessage(chatId,
      `⚠️ ═══════════════════════════\n` +
      `*WARNING ${n}/${MAX_WARNS}*\n` +
      `═══════════════════════════\n\n` +
      `👤 User: ${esc(user.first_name)}\n` +
      `📌 Reason: ${esc(reason)}\n` +
      `📊 Strikes: ${warnBar}\n\n` +
      `_💀 ${left} more strike${left !== 1 ? "s" : ""} = BAN_`,
      { parse_mode: "MarkdownV2" }
    );
    return false;
  }
}

// ─── Premium Welcome Templates ────────────────────────────────────────────────

const WELCOMES = {
  default: (u, g) =>
    `╔════════════════════════════╗\n` +
    `║   🛡️ *SHIELD GUARD PRO*    ║\n` +
    `╚════════════════════════════╝\n\n` +
    `🌟 Welcome ${u} to *${g}*\\!\n\n` +
    `✨ You have entered a premium protected group\\.\n` +
    `🔒 Anti\\-Link \\• Anti\\-Spam \\• 24/7 Shield\n\n` +
    `📝 *Rules:*\n` +
    `┃ ❌ No links allowed\n` +
    `┃ ❌ No @mentions\n` +
    `┃ ❌ No forwarded messages\n` +
    `┃ ❌ No unauthorized photos\n` +
    `┃ ⚠️ 3 strikes \\= instant ban\n\n` +
    `Enjoy your stay\\! 🎉`,

  elite: (u, g) =>
    `⚡ *\\[ ELITE ACCESS GRANTED \\]* ⚡\n\n` +
    `Welcome ${u} to *${g}*\n\n` +
    `🔥 This is an elite\\-protected zone\\.\n` +
    `🛡️ ShieldGuard Pro is actively monitoring\\.\n\n` +
    `⚡ *Protected by:*\n` +
    `┣ 🔗 Anti\\-Link Shield\n` +
    `┣ 📸 Anti\\-Photo Guard\n` +
    `┣ 🚫 Anti\\-Mention Wall\n` +
    `┣ 🌊 Anti\\-Flood Barrier\n` +
    `┗ ⚠️ Strike System \\(3 \\= Ban\\)\n\n` +
    `Welcome aboard\\! 🚀`,

  minimal: (u, g) =>
    `👋 Welcome ${u} to *${g}*\\!\n🛡️ Protected by ShieldGuard Pro\n⚠️ 3 strikes \\= ban\\. No links or spam\\.`,

  gaming: (u, g) =>
    `🎮 *PLAYER JOINED THE LOBBY* 🎮\n\n` +
    `👤 ${u} entered *${g}*\n\n` +
    `🛡️ *Active Buffs:*\n` +
    `┣ 🔗 Link Shield \\[MAX\\]\n` +
    `┣ 📸 Photo Block \\[MAX\\]\n` +
    `┣ 🚫 Mention Wall \\[MAX\\]\n` +
    `┣ 🌊 Flood Guard \\[MAX\\]\n` +
    `┗ ⚠️ Ban Hammer \\[3 STRIKES\\]\n\n` +
    `GLHF\\! 🎲`,

  neon: (u, g) =>
    `💎 *\\~\\~ NEON ZONE ACTIVATED \\~\\~* 💎\n\n` +
    `${u} \\→ *${g}*\n\n` +
    `🟣 ShieldGuard Pro \\| Online\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `🔗 Link Shield   ████ 100%\n` +
    `📸 Photo Guard   ████ 100%\n` +
    `🚫 Mention Wall  ████ 100%\n` +
    `🌊 Flood Barrier ████ 100%\n` +
    `⚠️ Ban Protocol  ████ READY\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Welcome to the grid\\. 💠`,
};

function welcomeText(name, group, tpl) {
  return (WELCOMES[tpl] || WELCOMES.default)(name, group);
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMMANDS
// ═══════════════════════════════════════════════════════════════════════════════

bot.command("start", async (ctx) => {
  if (ctx.chat.type === "private") {
    await ctx.reply(
      "🛡️ *ShieldGuard Bot v2\\.0 — Premium Protection*\n\n" +
      "Add me to a group and make me admin \\— all protections activate instantly\\!\n\n" +
      "🔹 Anti\\-Link \\(Telegram, WhatsApp, URLs\\)\n" +
      "🔹 Anti\\-@Mention\n" +
      "🔹 Anti\\-Photo\n" +
      "🔹 Anti\\-Forward\n" +
      "🔹 Anti\\-Flood\n" +
      "🔹 Warn System \\(3 \\= Ban\\)\n" +
      "🔹 Premium Welcome Messages\n\n" +
      "Use /help to see all commands\\.",
      { parse_mode: "MarkdownV2" }
    );
  } else {
    await ctx.reply(
      "🛡️ *ShieldGuard is active\\!* Use /help for commands\\.",
      { parse_mode: "MarkdownV2" }
    );
  }
});

bot.command("help", async (ctx) => {
  await ctx.reply(
    "🛡️ *ShieldGuard v2\\.0 — Command List*\n\n" +
    "📌 *User Commands:*\n" +
    "┣ /start \\— Start the bot\n" +
    "┣ /help \\— Show this message\n" +
    "┣ /warnings \\— Check your warnings\n" +
    "┗ /stats \\— Group protection stats\n\n" +
    "👑 *Admin Commands:*\n" +
    "┣ /settings \\— Toggle protection features\n" +
    "┣ /warn \\— Manually warn a user \\(reply\\)\n" +
    "┣ /unwarn \\— Remove one warning \\(reply\\)\n" +
    "┣ /resetwarns \\— Reset warnings \\(reply\\)\n" +
    "┗ /ban \\— Ban a user \\(reply\\)\n\n" +
    "⚙️ *Auto\\-Active Features:*\n" +
    "┣ 🔗 Anti\\-Link\n┣ 📸 Anti\\-Photo\n┣ 🚫 Anti\\-@Mention\n" +
    "┣ ↔️ Anti\\-Forward\n┣ 🌊 Anti\\-Flood\n┗ 🎉 Welcome Messages",
    { parse_mode: "MarkdownV2" }
  );
});

bot.command("warnings", async (ctx) => {
  if (ctx.chat.type === "private") { await ctx.reply("🚫 Groups only."); return; }
  const t = ctx.msg.reply_to_message ? ctx.msg.reply_to_message.from : ctx.from;
  const n = getWarns(ctx.chat.id, t.id);
  const left = MAX_WARNS - n;
  const bar = "🔴".repeat(n) + "⚪".repeat(left);
  await ctx.reply(
    `⚠️ *Warnings for ${esc(t.first_name)}:*\n📊 ${bar}\n📌 ${n}/${MAX_WARNS} \\— ${left} remaining`,
    { parse_mode: "MarkdownV2" }
  );
});

bot.command("resetwarns", async (ctx) => {
  if (ctx.chat.type === "private") return;
  if (!(await isAdmin(ctx.chat.id, ctx.from.id))) { await ctx.reply("🚫 Admin only."); return; }
  if (!ctx.msg.reply_to_message) { await ctx.reply("⚠️ Reply to a user's message."); return; }
  resetWarns(ctx.chat.id, ctx.msg.reply_to_message.from.id);
  await ctx.reply(`✅ Warnings reset for ${esc(ctx.msg.reply_to_message.from.first_name)}`, { parse_mode: "MarkdownV2" });
});

bot.command("warn", async (ctx) => {
  if (ctx.chat.type === "private") return;
  if (!(await isAdmin(ctx.chat.id, ctx.from.id))) { await ctx.reply("🚫 Admin only."); return; }
  if (!ctx.msg.reply_to_message) { await ctx.reply("⚠️ Reply to a user's message."); return; }
  const t = ctx.msg.reply_to_message.from;
  const reason = ctx.match || "Manual admin warning";
  const n = addWarn(ctx.chat.id, t.id);
  bumpStat(ctx.chat.id, "warns");
  const left = MAX_WARNS - n;
  if (n >= MAX_WARNS) {
    try {
      await bot.api.banChatMember(ctx.chat.id, t.id);
      bumpStat(ctx.chat.id, "bans"); resetWarns(ctx.chat.id, t.id);
      await ctx.reply(`🚫 *${esc(t.first_name)}* BANNED \\— ${MAX_WARNS} strikes reached\\!`, { parse_mode: "MarkdownV2" });
    } catch (e) { await ctx.reply(`⚠️ Ban failed: ${e.message}`); }
  } else {
    const bar = "🔴".repeat(n) + "⚪".repeat(left);
    await ctx.reply(
      `⚠️ *Warning ${n}/${MAX_WARNS}* for ${esc(t.first_name)}\n📊 ${bar}\n📌 ${esc(reason)}\n💀 ${left} strike${left !== 1 ? "s" : ""} left`,
      { parse_mode: "MarkdownV2" }
    );
  }
});

bot.command("unwarn", async (ctx) => {
  if (ctx.chat.type === "private") return;
  if (!(await isAdmin(ctx.chat.id, ctx.from.id))) { await ctx.reply("🚫 Admin only."); return; }
  if (!ctx.msg.reply_to_message) { await ctx.reply("⚠️ Reply to a user's message."); return; }
  const t = ctx.msg.reply_to_message.from;
  const cur = getWarns(ctx.chat.id, t.id);
  if (cur <= 0) { await ctx.reply("✅ No warnings."); return; }
  const cid = String(ctx.chat.id), uid = String(t.id);
  if (!store.warns[cid]) store.warns[cid] = {};
  store.warns[cid][uid] = cur - 1; save();
  await ctx.reply(`✅ Removed 1 warning from ${esc(t.first_name)} \\→ ${cur - 1}/${MAX_WARNS}`, { parse_mode: "MarkdownV2" });
});

bot.command("ban", async (ctx) => {
  if (ctx.chat.type === "private") return;
  if (!(await isAdmin(ctx.chat.id, ctx.from.id))) { await ctx.reply("🚫 Admin only."); return; }
  if (!ctx.msg.reply_to_message) { await ctx.reply("⚠️ Reply to a user's message."); return; }
  const t = ctx.msg.reply_to_message.from;
  const reason = ctx.match || "Admin ban";
  try {
    await bot.api.banChatMember(ctx.chat.id, t.id);
    bumpStat(ctx.chat.id, "bans"); resetWarns(ctx.chat.id, t.id);
    await ctx.reply(`🔨 *${esc(t.first_name)}* has been *BANNED*\n📌 ${esc(reason)}`, { parse_mode: "MarkdownV2" });
  } catch (e) { await ctx.reply(`⚠️ Ban failed: ${e.message}`); }
});

bot.command("stats", async (ctx) => {
  if (ctx.chat.type === "private") return;
  const s = store.stats[String(ctx.chat.id)] || { deletes: 0, warns: 0, bans: 0, welcomes: 0 };
  const g = getGroup(ctx.chat.id);
  const st = g.active ? "🟢 ACTIVE" : "🔴 INACTIVE";
  await ctx.reply(
    `📊 *ShieldGuard Stats — ${esc(ctx.chat.title)}*\n\n` +
    `🛡️ Status: ${st}\n` +
    `🗑️ Deleted: ${s.deletes} \\| ⚠️ Warns: ${s.warns}\n` +
    `🔨 Banned: ${s.bans} \\| 👋 Welcomes: ${s.welcomes}\n\n` +
    `⚙️ *Protections:*\n` +
    `┣ 🔗 Anti\\-Link: ${g.anti_link ? "✅" : "❌"}\n` +
    `┣ 🚫 Anti\\-@Mention: ${g.anti_mention ? "✅" : "❌"}\n` +
    `┣ 📸 Anti\\-Photo: ${g.anti_photo ? "✅" : "❌"}\n` +
    `┣ ↔️ Anti\\-Forward: ${g.anti_forward ? "✅" : "❌"}\n` +
    `┣ 🌊 Anti\\-Flood: ${g.anti_flood ? "✅" : "❌"}\n` +
    `┗ 🎭 Anti\\-Sticker: ${g.anti_sticker ? "✅" : "❌"}`,
    { parse_mode: "MarkdownV2" }
  );
});

// ─── Settings ─────────────────────────────────────────────────────────────────

bot.command("settings", async (ctx) => {
  if (ctx.chat.type === "private") return;
  if (!(await isAdmin(ctx.chat.id, ctx.from.id))) { await ctx.reply("🚫 Admin only."); return; }
  await settingsMenu(ctx);
});

async function settingsMenu(ctx) {
  const g = getGroup(ctx.chat.id);
  const feats = [
    ["anti_link", "🔗 Anti-Link"], ["anti_mention", "🚫 Anti-@Mention"],
    ["anti_photo", "📸 Anti-Photo"], ["anti_forward", "↔️ Anti-Forward"],
    ["anti_flood", "🌊 Anti-Flood"], ["anti_sticker", "🎭 Anti-Sticker"],
    ["welcome_enabled", "🎉 Welcome"],
  ];
  const kb = new InlineKeyboard();
  for (const [k, l] of feats) kb.text(`${g[k] ? "✅" : "❌"} ${l}`, `t_${k}`).row();
  kb.text("📝 Welcome Template", "wmenu");

  const st = g.active ? "🟢 ACTIVE" : "🔴 INACTIVE";
  const text = `🛡️ *ShieldGuard Settings*\nStatus: ${st}\n\nToggle features:`;
  if (ctx.callbackQuery) {
    await ctx.callbackQuery.editMessageText(text, { parse_mode: "Markdown", reply_markup: kb });
  } else {
    await ctx.reply(text, { parse_mode: "Markdown", reply_markup: kb });
  }
}

bot.callbackQuery(/^t_/, async (ctx) => {
  if (!(await isAdmin(ctx.chat.id, ctx.from.id))) { await ctx.answerCallbackQuery({ text: "🚫 Admin only!", show_alert: true }); return; }
  const k = ctx.callbackQuery.data.slice(2);
  const g = getGroup(ctx.chat.id);
  updateGroup(ctx.chat.id, k, !g[k]);
  await ctx.answerCallbackQuery({ text: `✅ ${k} ${!g[k] ? "ON" : "OFF"}` });
  await settingsMenu(ctx);
});

bot.callbackQuery("wmenu", async (ctx) => {
  if (!(await isAdmin(ctx.chat.id, ctx.from.id))) { await ctx.answerCallbackQuery({ text: "🚫 Admin only!", show_alert: true }); return; }
  const kb = new InlineKeyboard()
    .text("🌟 Default", "w_default").row()
    .text("⚡ Elite", "w_elite").row()
    .text("📌 Minimal", "w_minimal").row()
    .text("🎮 Gaming", "w_gaming").row()
    .text("💎 Neon", "w_neon").row()
    .text("🔙 Back", "wback");
  await ctx.callbackQuery.editMessageText("📝 *Pick a welcome template:*", { parse_mode: "Markdown", reply_markup: kb });
});

bot.callbackQuery(/^w_(?!back|menu)/, async (ctx) => {
  if (!(await isAdmin(ctx.chat.id, ctx.from.id))) { await ctx.answerCallbackQuery({ text: "🚫 Admin only!", show_alert: true }); return; }
  const tpl = ctx.callbackQuery.data.slice(2);
  updateGroup(ctx.chat.id, "welcome_text", tpl);
  await ctx.answerCallbackQuery({ text: `✅ Template: ${tpl}` });
  await ctx.callbackQuery.editMessageText(`✅ Welcome template set to *${tpl}*\\!`, { parse_mode: "MarkdownV2" });
});

bot.callbackQuery("wback", async (ctx) => {
  if (!(await isAdmin(ctx.chat.id, ctx.from.id))) { await ctx.answerCallbackQuery({ text: "🚫 Admin only!", show_alert: true }); return; }
  await settingsMenu(ctx);
});

// ─── Auto-Activate When Bot Becomes Admin ─────────────────────────────────────

let botId = null;

bot.on("my_chat_member", async (ctx) => {
  const u = ctx.myChatMember;
  if (!u) return;
  if (!botId) botId = (await bot.api.getMe()).id;
  if (u.new_chat_member.user.id !== botId) return;

  const chatId = u.chat.id;
  if (u.new_chat_member.status === "administrator" || u.new_chat_member.status === "creator") {
    updateGroup(chatId, "active", true);
    try {
      await bot.api.sendMessage(chatId,
        "🛡️ *ShieldGuard Pro Activated\\!* \\⚡\n\n" +
        "✅ All protections are now *ONLINE*\\.\n\n" +
        "🔗 Anti\\-Link \\• 📸 Anti\\-Photo \\• 🚫 Anti\\-Mention\n" +
        "↔️ Anti\\-Forward \\• 🌊 Anti\\-Flood \\• ⚠️ Warn System\n\n" +
        "Use /settings to customize\\.\nUse /help for commands\\.",
        { parse_mode: "MarkdownV2" }
      );
    } catch (e) { console.error("Activation msg failed:", e.message); }
  } else {
    updateGroup(chatId, "active", false);
  }
});

// ─── Welcome New Members ──────────────────────────────────────────────────────

bot.on(":new_chat_members", async (ctx) => {
  const chatId = ctx.chat.id;
  const g = getGroup(chatId);
  if (!g.welcome_enabled) return;

  if (!botId) botId = (await bot.api.getMe()).id;
  const groupName = esc(ctx.chat.title || "this group");
  const tpl = g.welcome_text || "default";

  for (const m of ctx.msg.new_chat_members) {
    if (m.id === botId) continue;
    const name = m.username ? `@${m.username}` : esc(m.first_name);
    try {
      await bot.api.sendMessage(chatId, welcomeText(name, groupName, tpl), { parse_mode: "MarkdownV2" });
      bumpStat(chatId, "welcomes");
    } catch (e) { console.error("Welcome failed:", e.message); }
  }
});

// ─── Message Protection Engine (FAST) ─────────────────────────────────────────

bot.on("message", async (ctx, next) => {
  if (!ctx.chat || ctx.chat.type === "private") return next();
  if (ctx.msg.text && ctx.msg.text.startsWith("/")) return next();

  const chatId = ctx.chat.id;
  const userId = ctx.from.id;
  const g = getGroup(chatId);

  if (!g.active) return next();
  if (await isAdmin(chatId, userId)) return next();

  const text = ctx.msg.text || ctx.msg.caption || "";
  let deleted = false;
  let reason = "";

  // Check all violations (fast — stop at first)
  if (g.anti_link && hasLink(text)) { reason = "🔗 Links not allowed"; }
  else if (g.anti_mention && hasMention(text)) { reason = "🚫 @Mentions not allowed"; }
  else if (g.anti_photo && ctx.msg.photo) { reason = "📸 Photos not allowed"; }
  else if (g.anti_forward && ctx.msg.forward_date) { reason = "↔️ Forwards not allowed"; }
  else if (g.anti_sticker && (ctx.msg.sticker || ctx.msg.animation)) { reason = "🎭 Stickers/GIFs not allowed"; }
  else if (g.anti_flood && checkFlood(chatId, userId)) { reason = "🌊 Flooding detected"; }

  if (reason) {
    try {
      await ctx.deleteMessage();
      deleted = true;
      bumpStat(chatId, "deletes");
    } catch (e) { /* already deleted or no permission */ }
  }

  if (deleted) await warnUser(chatId, ctx.from, reason);
});

// ─── Error Handler ────────────────────────────────────────────────────────────

bot.catch((err) => {
  const e = err.error || err;
  console.error("Bot error:", e.message || e);
});

// ─── HTTP Health Server (Required for Render) ─────────────────────────────────

function startHealthServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      bot: "ShieldGuard v2.0",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    }));
  });

  server.listen(PORT, () => {
    console.log(`🏥 Health server listening on port ${PORT}`);
  });
}

// ─── Start Everything ─────────────────────────────────────────────────────────

async function main() {
  console.log("🛡️ ShieldGuard v2.0 starting...");

  // Start health server FIRST (Render needs port binding within 60s)
  startHealthServer();

  try {
    await bot.api.deleteWebhook({ drop_pending_updates: true });
    console.log("✅ Webhook cleared");
  } catch (e) {
    if (e.error_code === 401) {
      console.error("❌ BOT_TOKEN is invalid! Get the correct token from @BotFather");
      console.error("   Set it as environment variable BOT_TOKEN on Render");
      console.error("   Bot will NOT start until the token is fixed.");
      console.error("   Health server is still running so Render won't crash.");
      return;
    }
    console.error("Webhook delete warning:", e.message);
  }

  console.log("🛡️ ShieldGuard Bot is LIVE!");
  bot.start({
    onStart: (info) => console.log(`🤖 Connected as @${info.username}`),
    drop_pending_updates: true,
  });
}

main().catch((err) => {
  console.error("Fatal:", err.message || err);
});
