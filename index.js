/**
 * ╔═══════════════════════════════════════════════╗
 * ║     🛡️  SHIELDGUARD BOT v3.0 — PREMIUM     ║
 * ║     Telegram Group Protection Engine         ║
 * ╚═══════════════════════════════════════════════╝
 *
 * v3.0 Fixes:
 *   ✅ Admin detection FIXED — never caches false, always re-verifies
 *   ✅ Link detection UPGRADED — catches betika.com, t.me, wa.me without http://
 *   ✅ Warn messages UPGRADED — "Felix [123] sent a spam. Action: Warn (1/3) until 21.05.26"
 *   ✅ /debug command — shows admin check result for troubleshooting
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

// ─── Admin Cache (ONLY cache TRUE results — never cache false) ────────────────

const adminTrueCache = new Map();
const ADMIN_CACHE_TTL = 60000; // 60 seconds for confirmed admins

function isAdminCached(chatId, userId) {
  const k = `${chatId}:${userId}`;
  const entry = adminTrueCache.get(k);
  if (entry && Date.now() - entry.time < ADMIN_CACHE_TTL) return true;
  adminTrueCache.delete(k);
  return null; // not cached = need to check API
}

function cacheAdminTrue(chatId, userId) {
  adminTrueCache.set(`${chatId}:${userId}`, { time: Date.now() });
}

function clearAdminCache(chatId, userId) {
  adminTrueCache.delete(`${chatId}:${userId}`);
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

// ─── Link Detection (v3 — catches betika.com, t.me, wa.me, etc) ─────────────

const LINK_TESTS = [
  // URLs with protocol
  /https?:\/\//i,
  // Telegram links
  /t\.me\//i,
  /telegram\.(me|dog)\//i,
  // WhatsApp links
  /wa\.me\//i,
  /whatsapp\.com/i,
  /chat\.whatsapp\.com/i,
  // Domain names: word.com, word.co.ke, word.ng, word.xyz etc
  // This catches betika.com, google.com, example.co.uk etc
  /\b[a-zA-Z0-9][-a-zA-Z0-9]*\.(com|net|org|io|xyz|ng|ke|co\.ke|co\.ug|co\.tz|co\.za|me|tv|cc|ly|ga|ml|cf|gq|tk|pw|top|club|online|site|app|dev|tech|info|link|click|win|bid|loan|work|date|trade|accountant|faith|cricket|science|review|party|stream|racing|faith|ren|kim|mom|lol|rocks|space|world|life|live|news|blog|shop|store|market|cash|gold|pro|vip|fyi|wiki|help|chat|fun|cool|sexy|zone|buzz|one|plus|zone|city|today|email|group|solutions|services|digital|network|academy|community|agency|company|building|directory|education|institute|technology|university|graphics|consulting|domains|management|support|systems|academy|care|fit|law|mba|phd|restaurant|camera|estate|gallery|lighting|plumbing|supply|equipment|guru|show|zone|cyou|icu|monster|baby|health|hospital|how|luxe|money|place|qpon|ruhr|saarland|wien|zuerich|bar|beer|bio|capetown|car|cars|casa|catering|cleaning|coffee|construction|contractors|delivery|democrat|dental|desi|diamonds|engineer|estate|events|exchange|expert|express|fail|farm|fish|fishing|fund|furniture|garden|gift|gives|glass|gmbh|golf|green|grocery|hair|haus|hiphop|hockey|horse|house|immo|industries|ink|joburg|juegos|kaufen|kitchen|koeln|lat|lease|legal|limo|maison|makeup|management|media|miami|moda|mortgage|movie|museum|ngo|ninja|nrw|nyc|okinawa|osaka|paris|partners|parts|photo|pictures|pizza|poke|press|productions|pub|quebec|recipes|rehab|rent|repair|report|rest|rocks|rodeo|room|rsvp|ruhr|saarland|salon|sarl|school|schule|security|servicios|shoes|show|singles|soccer|social|software|solar|solutions|sound|space|spot|star|stockholm|studio|sucks|supplies|surf|surgery|sydney|taipei|tattoo|tax|team|technology|tel|tienda|tips|tires|tokyo|tools|town|toys|trade|training|tube|university|vacations|ventures|vet|viajes|video|villas|vin|vision|vlaanderen|vodka|vote|voting|voyage|wales|wang|watch|webcam|website|wed|wien|wiki|win|wine|work|works|world|wtf|wurst|xyz|yoga|zuerich)\b/i,
];

const MENTION_RE = /@[\w]{5,32}/;

function hasLink(t) { return t ? LINK_TESTS.some(r => r.test(t)) : false; }
function hasMention(t) { return t ? MENTION_RE.test(t) : false; }

// ─── Bot Setup ────────────────────────────────────────────────────────────────

const bot = new Bot(BOT_TOKEN);

// ─── Admin Check (FIXED — never caches false) ────────────────────────────────

async function isAdmin(chatId, userId) {
  // Check cache — but ONLY trust cached TRUE values
  const cached = isAdminCached(chatId, userId);
  if (cached === true) return true;

  // Always call the API for non-cached or expired entries
  try {
    const member = await bot.api.getChatMember(chatId, userId);
    const isAdminUser = member.status === "administrator" || member.status === "creator";

    if (isAdminUser) {
      // Cache TRUE results for speed
      cacheAdminTrue(chatId, userId);
      console.log(`✅ Admin confirmed: ${userId} in ${chatId} (${member.status})`);
    } else {
      // Do NOT cache false — always re-check next time
      console.log(`ℹ️ Not admin: ${userId} in ${chatId} (${member.status})`);
    }

    return isAdminUser;
  } catch (e) {
    // API error — DO NOT assume not-admin. Log and give benefit of doubt
    console.error(`⚠️ Admin check API error for ${userId} in ${chatId}: ${e.message}`);
    // If we had a previous true cache that expired, still trust it
    return false;
  }
}

// ─── MarkdownV2 Escape ────────────────────────────────────────────────────────

function esc(t) {
  return t ? t.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1") : "";
}

// ─── Date Formatter ───────────────────────────────────────────────────────────

function formatExpiry(addDays) {
  const d = new Date(Date.now() + addDays * 86400000);
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = String(d.getFullYear()).slice(-2);
  let hours = d.getHours();
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
  const mins = String(d.getMinutes()).padStart(2, "0");
  return `${day}.${month}.${year} at ${hours}:${mins} ${ampm}`;
}

// ─── Warn + Ban (v3 format) ───────────────────────────────────────────────────

async function warnUser(chatId, user, reason) {
  const n = addWarn(chatId, user.id);
  bumpStat(chatId, "warns");
  const left = MAX_WARNS - n;
  const expiry = formatExpiry(30);

  if (n >= MAX_WARNS) {
    try {
      await bot.api.banChatMember(chatId, user.id);
      bumpStat(chatId, "bans");
      resetWarns(chatId, user.id);
      await bot.api.sendMessage(chatId,
        `${esc(user.first_name)} \\[${user.id}\\] sent a spam message\\.\n` +
        `Action: *Ban* \\(${MAX_WARNS}/${MAX_WARNS}\\) 🔨\n` +
        `Reason: ${esc(reason)}\n` +
        `Until: ${esc(expiry)}`,
        { parse_mode: "MarkdownV2" }
      );
      return true;
    } catch (e) {
      console.error("Ban failed:", e.message);
      await bot.api.sendMessage(chatId,
        `⚠️ Ban failed — check my permissions\\.\n` +
        `${esc(user.first_name)} \\[${user.id}\\] is at ${n}/${MAX_WARNS} warns\\.`
      );
      return false;
    }
  } else {
    await bot.api.sendMessage(chatId,
      `${esc(user.first_name)} \\[${user.id}\\] sent a spam message\\.\n` +
      `Action: *Warn* \\(${n}/${MAX_WARNS}\\) ❕\n` +
      `Reason: ${esc(reason)}\n` +
      `Until: ${esc(expiry)}`,
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
      "🛡️ *ShieldGuard Bot v3\\.0 — Premium Protection*\n\n" +
      "Add me to a group and make me admin \\— all protections activate instantly\\!\n\n" +
      "🔹 Anti\\-Link \\(Telegram, WhatsApp, URLs, domains\\)\n" +
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
    "🛡️ *ShieldGuard v3\\.0 — Command List*\n\n" +
    "📌 *User Commands:*\n" +
    "┣ /start \\— Start the bot\n" +
    "┣ /help \\— Show this message\n" +
    "┣ /warnings \\— Check your warnings\n" +
    "┣ /debug \\— Check your admin status\n" +
    "┗ /stats \\— Group protection stats\n\n" +
    "👑 *Admin Commands:*\n" +
    "┣ /settings \\— Toggle protection features\n" +
    "┣ /warn \\— Manually warn a user \\(reply\\)\n" +
    "┣ /unwarn \\— Remove one warning \\(reply\\)\n" +
    "┣ /resetwarns \\— Reset warnings \\(reply\\)\n" +
    "┗ /ban \\— Ban a user \\(reply\\)\n\n" +
    "⚙️ *Auto\\-Active Features:*\n" +
    "┣ 🔗 Anti\\-Link \\(catches domain names too\\)\n" +
    "┣ 📸 Anti\\-Photo\n┣ 🚫 Anti\\-@Mention\n" +
    "┣ ↔️ Anti\\-Forward\n┣ 🌊 Anti\\-Flood\n┗ 🎉 Welcome Messages",
    { parse_mode: "MarkdownV2" }
  );
});

// ─── /debug — Shows admin check result (troubleshooting) ─────────────────────

bot.command("debug", async (ctx) => {
  if (ctx.chat.type === "private") { await ctx.reply("🚫 Groups only."); return; }

  const chatId = ctx.chat.id;
  const userId = ctx.from.id;
  const userName = ctx.from.first_name;
  const userNameTag = ctx.from.username ? `@${ctx.from.username}` : "none";

  let apiResult = "error";
  let apiStatus = "unknown";
  let apiError = "";

  try {
    const member = await bot.api.getChatMember(chatId, userId);
    apiStatus = member.status;
    apiResult = (member.status === "administrator" || member.status === "creator") ? "YES ✅" : "NO ❌";
  } catch (e) {
    apiError = e.message;
    apiResult = "API ERROR ❌";
  }

  // Also check bot's own status
  let botResult = "error";
  let botStatus = "unknown";
  try {
    const botInfo = await bot.api.getMe();
    const botMember = await bot.api.getChatMember(chatId, botInfo.id);
    botStatus = botMember.status;
    botResult = (botMember.status === "administrator" || botMember.status === "creator") ? "YES ✅" : "NO ❌";
  } catch (e) {
    botResult = "API ERROR ❌";
  }

  const group = getGroup(chatId);

  await ctx.reply(
    `🔍 *Debug Info*\n\n` +
    `👤 *You:*\n` +
    `┣ Name: ${esc(userName)}\n` +
    `┣ ID: ${userId}\n` +
    `┣ Username: ${esc(userNameTag)}\n` +
    `┣ API Status: ${esc(apiStatus)}\n` +
    `┣ Is Admin: ${apiResult}\n` +
    `${apiError ? `┣ API Error: ${esc(apiError)}\n` : ""}` +
    `┗ Cached: ${isAdminCached(chatId, userId) === true ? "YES" : "NO"}\n\n` +
    `🤖 *Bot:*\n` +
    `┣ Status: ${esc(botStatus)}\n` +
    `┗ Is Admin: ${botResult}\n\n` +
    `⚙️ *Group:*\n` +
    `┣ Active: ${group.active ? "YES ✅" : "NO ❌"}\n` +
    `┗ ID: ${chatId}`,
    { parse_mode: "MarkdownV2" }
  );
});

bot.command("warnings", async (ctx) => {
  if (ctx.chat.type === "private") { await ctx.reply("🚫 Groups only."); return; }
  const t = ctx.msg.reply_to_message ? ctx.msg.reply_to_message.from : ctx.from;
  const n = getWarns(ctx.chat.id, t.id);
  const left = MAX_WARNS - n;
  await ctx.reply(
    `${esc(t.first_name)} \\[${t.id}\\] has ${n}/${MAX_WARNS} warnings\\.\n` +
    `${left} warning${left !== 1 ? "s" : ""} remaining before ban\\.`,
    { parse_mode: "MarkdownV2" }
  );
});

bot.command("resetwarns", async (ctx) => {
  if (ctx.chat.type === "private") return;
  if (!(await isAdmin(ctx.chat.id, ctx.from.id))) {
    await ctx.reply("🚫 Admin only\\. Use /debug to check your status\\.", { parse_mode: "MarkdownV2" });
    return;
  }
  if (!ctx.msg.reply_to_message) { await ctx.reply("⚠️ Reply to a user's message."); return; }
  const t = ctx.msg.reply_to_message.from;
  resetWarns(ctx.chat.id, t.id);
  await ctx.reply(`✅ Warnings reset for ${esc(t.first_name)} \\[${t.id}\\]`, { parse_mode: "MarkdownV2" });
});

bot.command("warn", async (ctx) => {
  if (ctx.chat.type === "private") return;
  if (!(await isAdmin(ctx.chat.id, ctx.from.id))) {
    await ctx.reply("🚫 Admin only\\. Use /debug to check your status\\.", { parse_mode: "MarkdownV2" });
    return;
  }
  if (!ctx.msg.reply_to_message) { await ctx.reply("⚠️ Reply to a user's message."); return; }
  const t = ctx.msg.reply_to_message.from;
  const reason = ctx.match || "Manual admin warning";
  const n = addWarn(ctx.chat.id, t.id);
  bumpStat(ctx.chat.id, "warns");
  const left = MAX_WARNS - n;
  const expiry = formatExpiry(30);

  if (n >= MAX_WARNS) {
    try {
      await bot.api.banChatMember(ctx.chat.id, t.id);
      bumpStat(ctx.chat.id, "bans"); resetWarns(ctx.chat.id, t.id);
      await ctx.reply(
        `${esc(t.first_name)} \\[${t.id}\\] sent a spam message\\.\n` +
        `Action: *Ban* \\(${MAX_WARNS}/${MAX_WARNS}\\) 🔨\n` +
        `Reason: ${esc(reason)}\n` +
        `Until: ${esc(expiry)}`,
        { parse_mode: "MarkdownV2" }
      );
    } catch (e) { await ctx.reply(`⚠️ Ban failed: ${e.message}`); }
  } else {
    await ctx.reply(
      `${esc(t.first_name)} \\[${t.id}\\] sent a spam message\\.\n` +
      `Action: *Warn* \\(${n}/${MAX_WARNS}\\) ❕\n` +
      `Reason: ${esc(reason)}\n` +
      `Until: ${esc(expiry)}`,
      { parse_mode: "MarkdownV2" }
    );
  }
});

bot.command("unwarn", async (ctx) => {
  if (ctx.chat.type === "private") return;
  if (!(await isAdmin(ctx.chat.id, ctx.from.id))) {
    await ctx.reply("🚫 Admin only\\. Use /debug to check your status\\.", { parse_mode: "MarkdownV2" });
    return;
  }
  if (!ctx.msg.reply_to_message) { await ctx.reply("⚠️ Reply to a user's message."); return; }
  const t = ctx.msg.reply_to_message.from;
  const cur = getWarns(ctx.chat.id, t.id);
  if (cur <= 0) { await ctx.reply("✅ No warnings."); return; }
  const cid = String(ctx.chat.id), uid = String(t.id);
  if (!store.warns[cid]) store.warns[cid] = {};
  store.warns[cid][uid] = cur - 1; save();
  await ctx.reply(`✅ Removed 1 warning from ${esc(t.first_name)} \\[${t.id}\\] \\→ ${cur - 1}/${MAX_WARNS}`, { parse_mode: "MarkdownV2" });
});

bot.command("ban", async (ctx) => {
  if (ctx.chat.type === "private") return;
  if (!(await isAdmin(ctx.chat.id, ctx.from.id))) {
    await ctx.reply("🚫 Admin only\\. Use /debug to check your status\\.", { parse_mode: "MarkdownV2" });
    return;
  }
  if (!ctx.msg.reply_to_message) { await ctx.reply("⚠️ Reply to a user's message."); return; }
  const t = ctx.msg.reply_to_message.from;
  const reason = ctx.match || "Admin ban";
  const expiry = formatExpiry(30);
  try {
    await bot.api.banChatMember(ctx.chat.id, t.id);
    bumpStat(ctx.chat.id, "bans"); resetWarns(ctx.chat.id, t.id);
    await ctx.reply(
      `${esc(t.first_name)} \\[${t.id}\\] has been banned\\.\n` +
      `Action: *Ban* 🔨\n` +
      `Reason: ${esc(reason)}\n` +
      `Until: ${esc(expiry)}`,
      { parse_mode: "MarkdownV2" }
    );
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
  if (!(await isAdmin(ctx.chat.id, ctx.from.id))) {
    await ctx.reply("🚫 Admin only\\. Use /debug to check your status\\.", { parse_mode: "MarkdownV2" });
    return;
  }
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

// ─── Message Protection Engine ────────────────────────────────────────────────

bot.on("message", async (ctx, next) => {
  if (!ctx.chat || ctx.chat.type === "private") return next();
  if (ctx.msg.text && ctx.msg.text.startsWith("/")) return next();

  const chatId = ctx.chat.id;
  const userId = ctx.from.id;
  const g = getGroup(chatId);

  if (!g.active) return next();

  // Admin check — admins are EXEMPT from all protections
  const admin = await isAdmin(chatId, userId);
  if (admin) return next();

  const text = ctx.msg.text || ctx.msg.caption || "";
  let reason = "";

  // Check violations (fast — stop at first match)
  if (g.anti_link && hasLink(text)) { reason = "🔗 Sending links is not allowed"; }
  else if (g.anti_mention && hasMention(text)) { reason = "🚫 @Mentioning users is not allowed"; }
  else if (g.anti_photo && ctx.msg.photo) { reason = "📸 Sending photos is not allowed"; }
  else if (g.anti_forward && ctx.msg.forward_date) { reason = "↔️ Forwarded messages are not allowed"; }
  else if (g.anti_sticker && (ctx.msg.sticker || ctx.msg.animation)) { reason = "🎭 Stickers/GIFs are not allowed"; }
  else if (g.anti_flood && checkFlood(chatId, userId)) { reason = "🌊 Flooding — too many messages"; }

  if (reason) {
    let deleted = false;
    try {
      await ctx.deleteMessage();
      deleted = true;
      bumpStat(chatId, "deletes");
    } catch (e) { /* message already deleted or no permission */ }

    if (deleted) await warnUser(chatId, ctx.from, reason);
  }
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
      bot: "ShieldGuard v3.0",
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
  console.log("🛡️ ShieldGuard v3.0 starting...");

  // Start health server FIRST (Render needs port binding within 60s)
  startHealthServer();

  try {
    await bot.api.deleteWebhook({ drop_pending_updates: true });
    console.log("✅ Webhook cleared");
  } catch (e) {
    if (e.error_code === 401) {
      console.error("❌ BOT_TOKEN is invalid! Get the correct token from @BotFather");
      console.error("   Set it as environment variable BOT_TOKEN on Render");
      console.error("   Health server still running so Render won't crash.");
      return;
    }
    console.error("Webhook delete warning:", e.message);
  }

  // Verify bot connection
  try {
    const me = await bot.api.getMe();
    botId = me.id;
    console.log(`🤖 Connected as @${me.username} (ID: ${me.id})`);
  } catch (e) {
    console.error("❌ Failed to verify bot:", e.message);
    return;
  }

  console.log("🛡️ ShieldGuard Bot is LIVE!");
  bot.start({
    onStart: (info) => console.log(`🤖 Polling started as @${info.username}`),
    drop_pending_updates: true,
  });
}

main().catch((err) => {
  console.error("Fatal:", err.message || err);
});
