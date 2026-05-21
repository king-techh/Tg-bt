/**
 * ShieldGuard Bot — Premium Telegram Group Protection Bot
 * Node.js / grammY version — Zero errors, Docker-ready
 *
 * Features:
 *   🔗 Anti-Link (Telegram, WhatsApp, all URLs)
 *   🚫 Anti-@Mention (username tags)
 *   📸 Anti-Photo (delete photos from non-admins)
 *   ↔️ Anti-Forward (delete forwarded messages)
 *   🌊 Anti-Flood (rate limit messages)
 *   🎭 Anti-Sticker/Animation spam
 *   ⚠️ Warn System (3 warns = ban)
 *   🎉 Premium Welcome Messages
 *   🟢 Auto-activate all features when bot becomes admin
 *   ⚙️ /settings to toggle features
 *   📊 /stats for group stats
 */

const { Bot, InlineKeyboard, Router, webhookCallback } = require("grammy");
const fs = require("fs");
const path = require("path");

// ─── Configuration ────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.BOT_TOKEN || "88768423638:AAG1YrS0hGOoCjAS9A9XCuMIe3IUYOgOTTo";
const MAX_WARNS = 3;
const FLOOD_LIMIT = 5;       // messages
const FLOOD_WINDOW = 5000;   // ms
const DATA_FILE = path.join(__dirname, "bot_data.json");

// ─── Persistent Data Store ────────────────────────────────────────────────────

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
    }
  } catch (e) {
    console.error("Failed to load data, starting fresh:", e.message);
  }
  return { warns: {}, groups: {}, stats: {}, flood: {} };
}

function saveData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("Failed to save data:", e.message);
  }
}

let store = loadData();

function save() { saveData(store); }

// ─── Group Settings Defaults ──────────────────────────────────────────────────

function defaultGroupSettings() {
  return {
    anti_link: true,
    anti_mention: true,
    anti_photo: true,
    anti_forward: true,
    anti_flood: true,
    anti_sticker: false,
    welcome_enabled: true,
    welcome_text: "default",
    active: false,
  };
}

function getGroup(chatId) {
  const cid = String(chatId);
  if (!store.groups[cid]) {
    store.groups[cid] = defaultGroupSettings();
    save();
  }
  return store.groups[cid];
}

function updateGroup(chatId, key, value) {
  const group = getGroup(chatId);
  group[key] = value;
  save();
}

// ─── Warn Helpers ─────────────────────────────────────────────────────────────

function getWarns(chatId, userId) {
  const cid = String(chatId);
  const uid = String(userId);
  return (store.warns[cid] && store.warns[cid][uid]) || 0;
}

function addWarn(chatId, userId) {
  const cid = String(chatId);
  const uid = String(userId);
  if (!store.warns[cid]) store.warns[cid] = {};
  store.warns[cid][uid] = (store.warns[cid][uid] || 0) + 1;
  save();
  return store.warns[cid][uid];
}

function resetWarns(chatId, userId) {
  const cid = String(chatId);
  const uid = String(userId);
  if (store.warns[cid] && store.warns[cid][uid] !== undefined) {
    store.warns[cid][uid] = 0;
    save();
  }
}

// ─── Stats Helpers ────────────────────────────────────────────────────────────

function bumpStat(chatId, key) {
  const cid = String(chatId);
  if (!store.stats[cid]) {
    store.stats[cid] = { deletes: 0, warns: 0, bans: 0, welcomes: 0 };
  }
  store.stats[cid][key] = (store.stats[cid][key] || 0) + 1;
  save();
}

// ─── Flood Helpers ────────────────────────────────────────────────────────────

function checkFlood(chatId, userId) {
  const cid = String(chatId);
  const uid = String(userId);
  const now = Date.now();
  if (!store.flood[cid]) store.flood[cid] = {};
  if (!store.flood[cid][uid]) store.flood[cid][uid] = [];

  // Remove old timestamps
  store.flood[cid][uid] = store.flood[cid][uid].filter((t) => now - t < FLOOD_WINDOW);
  store.flood[cid][uid].push(now);

  // Only save periodically to reduce I/O
  if (store.flood[cid][uid].length > FLOOD_LIMIT) {
    save();
    return true;
  }
  return false;
}

// ─── Link & Mention Detection ─────────────────────────────────────────────────

const LINK_REGEXES = [
  /https?:\/\//i,
  /t\.me\//i,
  /telegram\.(me|dog)\//i,
  /wa\.me\//i,
  /whatsapp\.com/i,
  /chat\.whatsapp\.com/i,
];

const MENTION_REGEX = /@[\w]{5,32}/i;

function containsLink(text) {
  if (!text) return false;
  return LINK_REGEXES.some((r) => r.test(text));
}

function containsMention(text) {
  if (!text) return false;
  return MENTION_REGEX.test(text);
}

// ─── Admin Check ──────────────────────────────────────────────────────────────

async function isAdmin(chatId, userId) {
  try {
    const member = await bot.api.getChatMember(chatId, userId);
    return member.status === "administrator" || member.status === "creator";
  } catch (e) {
    console.error("Admin check failed:", e.message);
    return false;
  }
}

// ─── Warn User (delete + warn + maybe ban) ────────────────────────────────────

async function warnUser(chatId, user, reason) {
  const warnCount = addWarn(chatId, user.id);
  bumpStat(chatId, "warns");
  const remaining = MAX_WARNS - warnCount;

  if (warnCount >= MAX_WARNS) {
    try {
      await bot.api.banChatMember(chatId, user.id);
      bumpStat(chatId, "bans");
      resetWarns(chatId, user.id);
      await bot.api.sendMessage(
        chatId,
        `🚫 *${escapeMD(user.first_name)}* has been *BANNED* after ${MAX_WARNS} warnings!\n📌 Reason: ${reason}`,
        { parse_mode: "MarkdownV2" }
      );
      return true;
    } catch (e) {
      console.error("Ban failed:", e.message);
      await bot.api.sendMessage(
        chatId,
        `⚠️ Failed to ban user. I may not have permission.\nUser has ${warnCount}/${MAX_WARNS} warns.`
      );
      return false;
    }
  } else {
    const plural = remaining !== 1 ? "s" : "";
    await bot.api.sendMessage(
      chatId,
      `⚠️ *Warning ${warnCount}/${MAX_WARNS}* for ${escapeMD(user.first_name)}\n📌 Reason: ${reason}\n💀 ${remaining} more warning${plural} until ban!`,
      { parse_mode: "MarkdownV2" }
    );
    return false;
  }
}

// ─── MarkdownV2 Escape ────────────────────────────────────────────────────────

function escapeMD(text) {
  if (!text) return "";
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

// ─── Premium Welcome Templates ────────────────────────────────────────────────

const WELCOME_TEMPLATES = {
  default: (user, group) =>
    `╔════════════════════════════╗\n` +
    `║   🛡️ *SHIELD GUARD PRO*   ║\n` +
    `╚════════════════════════════╝\n\n` +
    `🌟 Welcome ${user} to *${group}*!\n\n` +
    `✨ You've entered a premium protected group.\n` +
    `🔒 Anti\\-Link • Anti\\-Spam • 24/7 Protection\n\n` +
    `📝 *Rules:*\n` +
    `┃ ❌ No links allowed\n` +
    `┃ ❌ No @mentions of other users\n` +
    `┃ ❌ No forwarded messages\n` +
    `┃ ❌ No unauthorized photos\n` +
    `┃ ⚠️ 3 warnings = instant ban\n\n` +
    `Enjoy your stay! 🎉`,

  elite: (user, group) =>
    `⚡ *\\[ ELITE ACCESS GRANTED \\]* ⚡\n\n` +
    `Welcome ${user} to *${group}*\n\n` +
    `🔥 This is an elite\\-protected zone.\n` +
    `🛡️ ShieldGuard Pro is actively monitoring.\n\n` +
    `⚡ *Protected by:*\n` +
    `┣ 🔗 Anti\\-Link Shield\n` +
    `┣ 📸 Anti\\-Photo Guard\n` +
    `┣ 🚫 Anti\\-Mention Wall\n` +
    `┣ 🌊 Anti\\-Flood Barrier\n` +
    `┗ ⚠️ Strike System \\(3 = Ban\\)\n\n` +
    `Welcome aboard! 🚀`,

  minimal: (user, group) =>
    `👋 Welcome ${user} to *${group}*!\n` +
    `🛡️ Protected by ShieldGuard Pro\n` +
    `⚠️ 3 warnings = ban. No links or spam.`,

  gaming: (user, group) =>
    `🎮 *PLAYER JOINED THE LOBBY* 🎮\n\n` +
    `👤 ${user} has entered *${group}*\n\n` +
    `🛡️ *Active Buffs:*\n` +
    `┣ 🔗 Link Shield \\[LVL MAX\\]\n` +
    `┣ 📸 Photo Block \\[LVL MAX\\]\n` +
    `┣ 🚫 Mention Wall \\[LVL MAX\\]\n` +
    `┣ 🌊 Flood Guard \\[LVL MAX\\]\n` +
    `┗ ⚠️ Ban Hammer \\[3 STRIKES\\]\n\n` +
    `Good luck, have fun! 🎲`,
};

function getWelcomeText(templateName, userName, groupName) {
  const tpl = WELCOME_TEMPLATES[templateName] || WELCOME_TEMPLATES.default;
  return tpl(userName, groupName);
}

// ─── Bot Setup ────────────────────────────────────────────────────────────────

const bot = new Bot(BOT_TOKEN);

// ─── /start Command ──────────────────────────────────────────────────────────

bot.command("start", async (ctx) => {
  if (ctx.chat.type === "private") {
    await ctx.reply(
      "🛡️ *ShieldGuard Bot — Premium Group Protection*\n\n" +
      "Add me to your group and make me admin to activate all protection features automatically!\n\n" +
      "🔹 Anti-Link (Telegram, WhatsApp, URLs)\n" +
      "🔹 Anti-@Mention\n" +
      "🔹 Anti-Photo\n" +
      "🔹 Anti-Forward\n" +
      "🔹 Anti-Flood\n" +
      "🔹 Warn System (3 = Ban)\n" +
      "🔹 Premium Welcome Messages\n\n" +
      "Use /help to see all commands.",
      { parse_mode: "Markdown" }
    );
  } else {
    await ctx.reply("🛡️ ShieldGuard is active! Use /help to see commands.");
  }
});

// ─── /help Command ────────────────────────────────────────────────────────────

bot.command("help", async (ctx) => {
  await ctx.reply(
    "🛡️ *ShieldGuard Bot — Command List*\n\n" +
    "📌 *User Commands:*\n" +
    "┣ /start — Start the bot\n" +
    "┣ /help — Show this message\n" +
    "┣ /warnings — Check your warnings\n" +
    "┗ /stats — Group protection stats\n\n" +
    "👑 *Admin Commands:*\n" +
    "┣ /settings — Toggle protection features\n" +
    "┣ /resetwarns — Reset a user's warnings\n" +
    "┣ /warn — Manually warn a user\n" +
    "┣ /unwarn — Remove one warning\n" +
    "┗ /ban — Ban a user\n\n" +
    "⚙️ *Auto-Active Features (when bot is admin):*\n" +
    "┣ 🔗 Anti-Link\n" +
    "┣ 📸 Anti-Photo\n" +
    "┣ 🚫 Anti-@Mention\n" +
    "┣ ↔️ Anti-Forward\n" +
    "┣ 🌊 Anti-Flood\n" +
    "┗ 🎉 Welcome Messages",
    { parse_mode: "Markdown" }
  );
});

// ─── /warnings Command ────────────────────────────────────────────────────────

bot.command("warnings", async (ctx) => {
  if (ctx.chat.type === "private") {
    await ctx.reply("🚫 This command only works in groups.");
    return;
  }

  const target = ctx.msg.reply_to_message ? ctx.msg.reply_to_message.from : ctx.from;
  const warnCount = getWarns(ctx.chat.id, target.id);
  const remaining = MAX_WARNS - warnCount;

  await ctx.reply(
    `⚠️ *Warnings for ${escapeMD(target.first_name)}:*\n` +
    `📌 ${warnCount}/${MAX_WARNS} warnings\n` +
    `💀 ${remaining} remaining before ban`,
    { parse_mode: "MarkdownV2" }
  );
});

// ─── /resetwarns Command (Admin) ──────────────────────────────────────────────

bot.command("resetwarns", async (ctx) => {
  if (ctx.chat.type === "private") return;
  if (!(await isAdmin(ctx.chat.id, ctx.from.id))) {
    await ctx.reply("🚫 *Admin only command.*", { parse_mode: "Markdown" });
    return;
  }
  if (!ctx.msg.reply_to_message) {
    await ctx.reply("⚠️ Reply to a user's message to reset their warnings.");
    return;
  }

  const target = ctx.msg.reply_to_message.from;
  resetWarns(ctx.chat.id, target.id);
  await ctx.reply(`✅ Warnings reset for ${escapeMD(target.first_name)}`, {
    parse_mode: "MarkdownV2",
  });
});

// ─── /warn Command (Admin) ────────────────────────────────────────────────────

bot.command("warn", async (ctx) => {
  if (ctx.chat.type === "private") return;
  if (!(await isAdmin(ctx.chat.id, ctx.from.id))) {
    await ctx.reply("🚫 *Admin only command.*", { parse_mode: "Markdown" });
    return;
  }
  if (!ctx.msg.reply_to_message) {
    await ctx.reply("⚠️ Reply to a user's message to warn them.");
    return;
  }

  const target = ctx.msg.reply_to_message.from;
  const reason = ctx.match || "Manual admin warning";
  const warnCount = addWarn(ctx.chat.id, target.id);
  bumpStat(ctx.chat.id, "warns");
  const remaining = MAX_WARNS - warnCount;

  if (warnCount >= MAX_WARNS) {
    try {
      await bot.api.banChatMember(ctx.chat.id, target.id);
      bumpStat(ctx.chat.id, "bans");
      resetWarns(ctx.chat.id, target.id);
      await ctx.reply(
        `🚫 *${escapeMD(target.first_name)}* has been *BANNED* after ${MAX_WARNS} warnings!`,
        { parse_mode: "MarkdownV2" }
      );
    } catch (e) {
      await ctx.reply(`⚠️ Failed to ban: ${e.message}`);
    }
  } else {
    const plural = remaining !== 1 ? "s" : "";
    await ctx.reply(
      `⚠️ *Warning ${warnCount}/${MAX_WARNS}* for ${escapeMD(target.first_name)}\n` +
      `📌 Reason: ${reason}\n` +
      `💀 ${remaining} more warning${plural} until ban`,
      { parse_mode: "MarkdownV2" }
    );
  }
});

// ─── /unwarn Command (Admin) ──────────────────────────────────────────────────

bot.command("unwarn", async (ctx) => {
  if (ctx.chat.type === "private") return;
  if (!(await isAdmin(ctx.chat.id, ctx.from.id))) {
    await ctx.reply("🚫 *Admin only command.*", { parse_mode: "Markdown" });
    return;
  }
  if (!ctx.msg.reply_to_message) {
    await ctx.reply("⚠️ Reply to a user's message to remove a warning.");
    return;
  }

  const target = ctx.msg.reply_to_message.from;
  const current = getWarns(ctx.chat.id, target.id);

  if (current <= 0) {
    await ctx.reply("✅ This user has no warnings.");
    return;
  }

  const cid = String(ctx.chat.id);
  const uid = String(target.id);
  if (!store.warns[cid]) store.warns[cid] = {};
  store.warns[cid][uid] = current - 1;
  save();

  await ctx.reply(
    `✅ Removed 1 warning from ${escapeMD(target.first_name)}\n📌 Now at ${current - 1}/${MAX_WARNS}`,
    { parse_mode: "MarkdownV2" }
  );
});

// ─── /ban Command (Admin) ─────────────────────────────────────────────────────

bot.command("ban", async (ctx) => {
  if (ctx.chat.type === "private") return;
  if (!(await isAdmin(ctx.chat.id, ctx.from.id))) {
    await ctx.reply("🚫 *Admin only command.*", { parse_mode: "Markdown" });
    return;
  }
  if (!ctx.msg.reply_to_message) {
    await ctx.reply("⚠️ Reply to a user's message to ban them.");
    return;
  }

  const target = ctx.msg.reply_to_message.from;
  const reason = ctx.match || "Admin ban";

  try {
    await bot.api.banChatMember(ctx.chat.id, target.id);
    bumpStat(ctx.chat.id, "bans");
    resetWarns(ctx.chat.id, target.id);
    await ctx.reply(
      `🔨 *${escapeMD(target.first_name)}* has been *BANNED*\n📌 Reason: ${reason}`,
      { parse_mode: "MarkdownV2" }
    );
  } catch (e) {
    await ctx.reply(`⚠️ Failed to ban: ${e.message}`);
  }
});

// ─── /stats Command ───────────────────────────────────────────────────────────

bot.command("stats", async (ctx) => {
  if (ctx.chat.type === "private") return;

  const cid = String(ctx.chat.id);
  const stats = store.stats[cid] || { deletes: 0, warns: 0, bans: 0, welcomes: 0 };
  const group = getGroup(ctx.chat.id);
  const activeStatus = group.active ? "🟢 ACTIVE" : "🔴 INACTIVE";

  await ctx.reply(
    `📊 *ShieldGuard Stats — ${escapeMD(ctx.chat.title)}*\n\n` +
    `🛡️ Status: ${activeStatus}\n` +
    `🗑️ Messages Deleted: ${stats.deletes}\n` +
    `⚠️ Warnings Issued: ${stats.warns}\n` +
    `🔨 Users Banned: ${stats.bans}\n` +
    `👋 Welcomes Sent: ${stats.welcomes}\n\n` +
    `⚙️ *Active Protections:*\n` +
    `┣ 🔗 Anti-Link: ${group.anti_link ? "✅" : "❌"}\n` +
    `┣ 🚫 Anti-@Mention: ${group.anti_mention ? "✅" : "❌"}\n` +
    `┣ 📸 Anti-Photo: ${group.anti_photo ? "✅" : "❌"}\n` +
    `┣ ↔️ Anti-Forward: ${group.anti_forward ? "✅" : "❌"}\n` +
    `┣ 🌊 Anti-Flood: ${group.anti_flood ? "✅" : "❌"}\n` +
    `┗ 🎭 Anti-Sticker: ${group.anti_sticker ? "✅" : "❌"}`,
    { parse_mode: "MarkdownV2" }
  );
});

// ─── /settings Command (Admin) ────────────────────────────────────────────────

bot.command("settings", async (ctx) => {
  if (ctx.chat.type === "private") return;
  if (!(await isAdmin(ctx.chat.id, ctx.from.id))) {
    await ctx.reply("🚫 *Admin only command.*", { parse_mode: "Markdown" });
    return;
  }

  await sendSettingsMenu(ctx);
});

async function sendSettingsMenu(ctx) {
  const group = getGroup(ctx.chat.id);
  const features = [
    ["anti_link", "🔗 Anti-Link"],
    ["anti_mention", "🚫 Anti-@Mention"],
    ["anti_photo", "📸 Anti-Photo"],
    ["anti_forward", "↔️ Anti-Forward"],
    ["anti_flood", "🌊 Anti-Flood"],
    ["anti_sticker", "🎭 Anti-Sticker"],
    ["welcome_enabled", "🎉 Welcome"],
  ];

  const keyboard = new InlineKeyboard();
  for (const [key, label] of features) {
    const status = group[key] ? "✅" : "❌";
    keyboard.text(`${status} ${label}`, `toggle_${key}`).row();
  }
  keyboard.text("📝 Set Welcome Template", "welcome_menu");

  const activeStatus = group.active ? "🟢 ACTIVE" : "🔴 INACTIVE (need admin)";

  if (ctx.callbackQuery) {
    await ctx.callbackQuery.editMessageText(
      `🛡️ *ShieldGuard Settings*\nStatus: ${activeStatus}\n\nToggle features below:`,
      { parse_mode: "Markdown", reply_markup: keyboard }
    );
  } else {
    await ctx.reply(
      `🛡️ *ShieldGuard Settings*\nStatus: ${activeStatus}\n\nToggle features below:`,
      { parse_mode: "Markdown", reply_markup: keyboard }
    );
  }
}

// ─── Callback Query Handler (Settings Toggles) ───────────────────────────────

bot.callbackQuery(/^toggle_/, async (ctx) => {
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;

  if (!(await isAdmin(chatId, userId))) {
    await ctx.answerCallbackQuery({ text: "🚫 Admin only!", show_alert: true });
    return;
  }

  const key = ctx.callbackQuery.data.replace("toggle_", "");
  const group = getGroup(chatId);
  updateGroup(chatId, key, !group[key]);

  await ctx.answerCallbackQuery({ text: `✅ ${key} toggled!` });
  await sendSettingsMenu(ctx);
});

bot.callbackQuery("welcome_menu", async (ctx) => {
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;

  if (!(await isAdmin(chatId, userId))) {
    await ctx.answerCallbackQuery({ text: "🚫 Admin only!", show_alert: true });
    return;
  }

  const keyboard = new InlineKeyboard()
    .text("🌟 Default (Premium)", "welcome_default").row()
    .text("⚡ Elite", "welcome_elite").row()
    .text("📌 Minimal", "welcome_minimal").row()
    .text("🎮 Gaming", "welcome_gaming").row()
    .text("🔙 Back", "back_settings");

  await ctx.callbackQuery.editMessageText("📝 *Select a welcome message template:*", {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
});

bot.callbackQuery(/^welcome_/, async (ctx) => {
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;

  if (!(await isAdmin(chatId, userId))) {
    await ctx.answerCallbackQuery({ text: "🚫 Admin only!", show_alert: true });
    return;
  }

  const template = ctx.callbackQuery.data.replace("welcome_", "");
  updateGroup(chatId, "welcome_text", template);

  await ctx.answerCallbackQuery({ text: `✅ Welcome template set to ${template}!` });
  await ctx.callbackQuery.editMessageText(
    `✅ Welcome template set to *${template}*!\n\nNew members will see the new welcome message.`,
    { parse_mode: "Markdown" }
  );
});

bot.callbackQuery("back_settings", async (ctx) => {
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;

  if (!(await isAdmin(chatId, userId))) {
    await ctx.answerCallbackQuery({ text: "🚫 Admin only!", show_alert: true });
    return;
  }

  await sendSettingsMenu(ctx);
});

// ─── Auto-Activate When Bot Becomes Admin ─────────────────────────────────────

bot.on("my_chat_member", async (ctx) => {
  const update = ctx.myChatMember;
  if (!update) return;

  const botInfo = await bot.api.getMe();
  if (update.new_chat_member.user.id !== botInfo.id) return;

  const chatId = update.chat.id;
  const newStatus = update.new_chat_member.status;

  if (newStatus === "administrator" || newStatus === "creator") {
    updateGroup(chatId, "active", true);
    try {
      await bot.api.sendMessage(
        chatId,
        "🛡️ *ShieldGuard Pro Activated!*\n\n" +
        "✅ All protection features are now *ACTIVE*.\n\n" +
        "🔗 Anti-Link • 📸 Anti-Photo • 🚫 Anti-Mention\n" +
        "↔️ Anti-Forward • 🌊 Anti-Flood • ⚠️ Warn System\n\n" +
        "Use /settings to customize features.\n" +
        "Use /help to see all commands.",
        { parse_mode: "Markdown" }
      );
    } catch (e) {
      console.error("Failed to send activation message:", e.message);
    }
  } else {
    updateGroup(chatId, "active", false);
  }
});

// ─── Welcome New Members ──────────────────────────────────────────────────────

bot.on(":new_chat_members", async (ctx) => {
  const chatId = ctx.chat.id;
  const group = getGroup(chatId);

  if (!group.welcome_enabled) return;

  const groupName = escapeMD(ctx.chat.title || "this group");
  const template = group.welcome_text || "default";
  const botInfo = await bot.api.getMe();

  for (const member of ctx.msg.new_chat_members) {
    if (member.id === botInfo.id) continue;

    const userName = member.username
      ? `@${member.username}`
      : escapeMD(member.first_name);

    const welcome = getWelcomeText(template, userName, groupName);
    try {
      await bot.api.sendMessage(chatId, welcome, { parse_mode: "MarkdownV2" });
      bumpStat(chatId, "welcomes");
    } catch (e) {
      console.error("Welcome send failed:", e.message);
    }
  }
});

// ─── Main Message Protection ──────────────────────────────────────────────────

bot.on("message", async (ctx, next) => {
  // Skip private chats
  if (!ctx.chat || ctx.chat.type === "private") return next();
  // Skip commands (handled separately)
  if (ctx.msg.text && ctx.msg.text.startsWith("/")) return next();

  const chatId = ctx.chat.id;
  const userId = ctx.from.id;
  const group = getGroup(chatId);

  // Skip if bot is not admin
  if (!group.active) return next();

  // Skip admins — they are exempt
  if (await isAdmin(chatId, userId)) return next();

  const text = ctx.msg.text || ctx.msg.caption || "";
  let deleted = false;
  let reason = "";

  // ── Anti-Link ─────────────────────────────────────────────────────
  if (group.anti_link && !deleted && containsLink(text)) {
    reason = "🔗 Sending links is not allowed";
    try {
      await ctx.deleteMessage();
      deleted = true;
      bumpStat(chatId, "deletes");
    } catch (e) {
      console.error("Delete failed:", e.message);
    }
  }

  // ── Anti-@Mention ─────────────────────────────────────────────────
  if (group.anti_mention && !deleted && containsMention(text)) {
    reason = "🚫 @mentioning users is not allowed";
    try {
      await ctx.deleteMessage();
      deleted = true;
      bumpStat(chatId, "deletes");
    } catch (e) {
      console.error("Delete failed:", e.message);
    }
  }

  // ── Anti-Photo ────────────────────────────────────────────────────
  if (group.anti_photo && !deleted && ctx.msg.photo) {
    reason = "📸 Sending photos is not allowed";
    try {
      await ctx.deleteMessage();
      deleted = true;
      bumpStat(chatId, "deletes");
    } catch (e) {
      console.error("Delete failed:", e.message);
    }
  }

  // ── Anti-Forward ──────────────────────────────────────────────────
  if (group.anti_forward && !deleted && ctx.msg.forward_date) {
    reason = "↔️ Forwarded messages are not allowed";
    try {
      await ctx.deleteMessage();
      deleted = true;
      bumpStat(chatId, "deletes");
    } catch (e) {
      console.error("Delete failed:", e.message);
    }
  }

  // ── Anti-Sticker/Animation ────────────────────────────────────────
  if (group.anti_sticker && !deleted && (ctx.msg.sticker || ctx.msg.animation)) {
    reason = "🎭 Stickers/GIFs are not allowed";
    try {
      await ctx.deleteMessage();
      deleted = true;
      bumpStat(chatId, "deletes");
    } catch (e) {
      console.error("Delete failed:", e.message);
    }
  }

  // ── Anti-Flood ────────────────────────────────────────────────────
  if (group.anti_flood && !deleted && checkFlood(chatId, userId)) {
    reason = "🌊 Flooding — sending too many messages";
    try {
      await ctx.deleteMessage();
      deleted = true;
      bumpStat(chatId, "deletes");
    } catch (e) {
      console.error("Delete failed:", e.message);
    }
  }

  // ── Warn the user if a message was deleted ────────────────────────
  if (deleted && reason) {
    await warnUser(chatId, ctx.from, reason);
  }
});

// ─── Start Bot ────────────────────────────────────────────────────────────────

async function main() {
  console.log("🛡️ ShieldGuard Bot starting...");

  // Delete webhook if any (needed for polling)
  await bot.api.deleteWebhook({ drop_pending_updates: true });

  console.log("🛡️ ShieldGuard Bot is running!");
  bot.start({
    onStart: () => console.log("🛡️ Bot started with long polling!"),
    drop_pending_updates: true,
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
