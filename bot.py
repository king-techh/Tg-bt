"""
ShieldGuard Bot - Premium Telegram Group Protection Bot
Features:
  - Anti-Link (Telegram, WhatsApp, all URLs)
  - Anti-@Mention (username tags)
  - Anti-Photo (delete photos from non-admins)
  - Anti-Forward (delete forwarded messages)
  - Anti-Flood (rate limit messages)
  - Anti-Sticker/Animation spam
  - Warn System (3 warns = ban)
  - Premium Welcome Messages
  - Auto-activate all features when bot is admin
  - /settings command to toggle features
  - /warnings command to check warns
  - /resetwarns command for admins
  - /stats command for group stats
  - /help command
"""

import os
import re
import json
import logging
import asyncio
from datetime import datetime, timedelta
from collections import defaultdict
from functools import wraps

from telegram import (
    Update,
    ChatMember,
    ChatMemberAdministrator,
    ChatMemberOwner,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
)
from telegram.ext import (
    ApplicationBuilder,
    CommandHandler,
    MessageHandler,
    ChatMemberHandler,
    CallbackQueryHandler,
    ContextTypes,
    filters,
)
from telegram.constants import ChatMemberStatus, ParseMode, MessageType

# ─── Configuration ────────────────────────────────────────────────────────────

BOT_TOKEN = os.environ.get("BOT_TOKEN", "88768423638:AAG1YrS0hGOoCjAS9A9XCuMIe3IUYOgOTTo")
MAX_WARNS = 3
FLOOD_LIMIT = 5          # messages
FLOOD_WINDOW = 5         # seconds
DATA_FILE = "bot_data.json"

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s", level=logging.INFO
)
logger = logging.getLogger(__name__)

# ─── Persistent Data Store ────────────────────────────────────────────────────

class DataStore:
    """Simple JSON-based persistent storage."""

    def __init__(self, path: str = DATA_FILE):
        self.path = path
        self.data = self._load()

    def _load(self) -> dict:
        if os.path.exists(self.path):
            try:
                with open(self.path, "r") as f:
                    return json.load(f)
            except (json.JSONDecodeError, IOError):
                return self._default()
        return self._default()

    def _default(self) -> dict:
        return {
            "warns": {},           # chat_id -> user_id -> count
            "groups": {},          # chat_id -> group settings
            "stats": {},           # chat_id -> {deletes, warns, bans, welcomes}
            "flood": {},           # chat_id -> user_id -> [timestamps]
        }

    def save(self):
        try:
            with open(self.path, "w") as f:
                json.dump(self.data, f, default=str)
        except IOError as e:
            logger.error(f"Failed to save data: {e}")

    # ── Warn helpers ──────────────────────────────────────────────────────

    def get_warns(self, chat_id: int, user_id: int) -> int:
        return self.data["warns"].get(str(chat_id), {}).get(str(user_id), 0)

    def add_warn(self, chat_id: int, user_id: int) -> int:
        cid, uid = str(chat_id), str(user_id)
        if cid not in self.data["warns"]:
            self.data["warns"][cid] = {}
        self.data["warns"][cid][uid] = self.data["warns"][cid].get(uid, 0) + 1
        self.save()
        return self.data["warns"][cid][uid]

    def reset_warns(self, chat_id: int, user_id: int):
        cid, uid = str(chat_id), str(user_id)
        if cid in self.data["warns"] and uid in self.data["warns"][cid]:
            self.data["warns"][cid][uid] = 0
            self.save()

    # ── Group settings ────────────────────────────────────────────────────

    def get_group(self, chat_id: int) -> dict:
        cid = str(chat_id)
        if cid not in self.data["groups"]:
            self.data["groups"][cid] = self._default_group_settings()
            self.save()
        return self.data["groups"][cid]

    def update_group(self, chat_id: int, key: str, value):
        group = self.get_group(chat_id)
        group[key] = value
        self.save()

    @staticmethod
    def _default_group_settings() -> dict:
        return {
            "anti_link": True,
            "anti_mention": True,
            "anti_photo": True,
            "anti_forward": True,
            "anti_flood": True,
            "anti_sticker": False,
            "welcome_enabled": True,
            "welcome_text": "default",
            "active": False,       # becomes True once bot is admin
        }

    # ── Stats helpers ─────────────────────────────────────────────────────

    def bump_stat(self, chat_id: int, key: str):
        cid = str(chat_id)
        if cid not in self.data["stats"]:
            self.data["stats"][cid] = {"deletes": 0, "warns": 0, "bans": 0, "welcomes": 0}
        self.data["stats"][cid][key] = self.data["stats"][cid].get(key, 0) + 1
        self.save()

    # ── Flood helpers ─────────────────────────────────────────────────────

    def check_flood(self, chat_id: int, user_id: int) -> bool:
        """Returns True if user is flooding."""
        cid, uid = str(chat_id), str(user_id)
        now = datetime.utcnow().timestamp()
        if cid not in self.data["flood"]:
            self.data["flood"][cid] = {}
        if uid not in self.data["flood"][cid]:
            self.data["flood"][cid][uid] = []
        # Remove old timestamps
        self.data["flood"][cid][uid] = [
            t for t in self.data["flood"][cid][uid]
            if now - t < FLOOD_WINDOW
        ]
        self.data["flood"][cid][uid].append(now)
        self.save()
        return len(self.data["flood"][cid][uid]) > FLOOD_LIMIT


store = DataStore()

# ─── Helper Functions ─────────────────────────────────────────────────────────

# Regex patterns for link detection
LINK_PATTERNS = [
    re.compile(r"(?i)https?://", re.IGNORECASE),
    re.compile(r"(?i)t\.me/", re.IGNORECASE),
    re.compile(r"(?i)telegram\.(me|dog)/", re.IGNORECASE),
    re.compile(r"(?i)wa\.me/", re.IGNORECASE),
    re.compile(r"(?i)whatsapp\.com/", re.IGNORECASE),
    re.compile(r"(?i)chat\.whatsapp\.com/", re.IGNORECASE),
    re.compile(r"(?i)whatsapp\.com/channel/", re.IGNORECASE),
]

MENTION_PATTERN = re.compile(r"@[\w]{5,32}", re.IGNORECASE)


def contains_link(text: str) -> bool:
    """Check if text contains any prohibited links."""
    if not text:
        return False
    for pattern in LINK_PATTERNS:
        if pattern.search(text):
            return True
    return False


def contains_mention(text: str) -> bool:
    """Check if text contains @username mentions."""
    if not text:
        return False
    return bool(MENTION_PATTERN.search(text))


async def is_admin(chat_id: int, user_id: int, context: ContextTypes.DEFAULT_TYPE) -> bool:
    """Check if a user is an admin or owner in the chat."""
    try:
        member = await context.bot.get_chat_member(chat_id, user_id)
        return member.status in (
            ChatMemberStatus.ADMINISTRATOR,
            ChatMemberStatus.OWNER,
        )
    except Exception:
        return False


async def is_bot_admin(chat_id: int, context: ContextTypes.DEFAULT_TYPE) -> bool:
    """Check if the bot itself is admin."""
    bot_id = (await context.bot.get_me()).id
    return await is_admin(chat_id, bot_id, context)


def admin_only(func):
    """Decorator: only allow admins to run the command."""
    @wraps(func)
    async def wrapper(update: Update, context: ContextTypes.DEFAULT_TYPE):
        if not update.effective_chat or not update.effective_user:
            return
        if await is_admin(update.effective_chat.id, update.effective_user.id, context):
            return await func(update, context)
        await update.message.reply_text(
            "🚫 *Admin only command.*", parse_mode=ParseMode.MARKDOWN
        )
    return wrapper


def group_only(func):
    """Decorator: only work in group chats."""
    @wraps(func)
    async def wrapper(update: Update, context: ContextTypes.DEFAULT_TYPE):
        if not update.effective_chat or update.effective_chat.type == "private":
            await update.message.reply_text(
                "🚫 This command only works in groups.", parse_mode=ParseMode.MARKDOWN
            )
            return
        return await func(update, context)
    return wrapper


async def warn_user(update: Update, context: ContextTypes.DEFAULT_TYPE, reason: str) -> bool:
    """
    Warn a user. Returns True if the user was banned (reached max warns).
    """
    chat_id = update.effective_chat.id
    user = update.effective_user
    warn_count = store.add_warn(chat_id, user.id)
    store.bump_stat(chat_id, "warns")

    remaining = MAX_WARNS - warn_count

    if warn_count >= MAX_WARNS:
        # Ban the user
        try:
            await context.bot.ban_chat_member(chat_id, user.id)
            store.bump_stat(chat_id, "bans")
            await update.effective_chat.send_message(
                f"🚫 *{user.mention_markdown_v2()}* has been *BANNED* after {MAX_WARNS} warnings\!\n"
                f"📌 Reason: {reason}",
                parse_mode=ParseMode.MARKDOWN_V2,
            )
            store.reset_warns(chat_id, user.id)
            return True
        except Exception as e:
            logger.error(f"Failed to ban user: {e}")
            await update.effective_chat.send_message(
                f"⚠️ Failed to ban user. I may not have permission.\n"
                f"User has {warn_count}/{MAX_WARNS} warns.",
            )
            return False
    else:
        await update.effective_chat.send_message(
            f"⚠️ *Warning {warn_count}/{MAX_WARNS}* for {user.mention_markdown_v2()}\n"
            f"📌 Reason: {reason}\n"
            f"💀 {remaining} more warning{'s' if remaining != 1 else ''} until ban\!",
            parse_mode=ParseMode.MARKDOWN_V2,
        )
        return False


# ─── Premium Welcome Messages ─────────────────────────────────────────────────

WELCOME_TEMPLATES = {
    "default": (
        "╔════════════════════════════╗\n"
        "║   🛡️ *SHIELD GUARD PRO*   ║\n"
        "╚════════════════════════════╝\n\n"
        "🌟 Welcome {user} to *{group}*\\!\n\n"
        "✨ You've entered a premium protected group\\.\n"
        "🔒 Anti\\-Link • Anti\\-Spam • 24/7 Protection\n\n"
        "📝 *Rules:*\n"
        "┃ ❌ No links allowed\n"
        "┃ ❌ No @mentions of other users\n"
        "┃ ❌ No forwarded messages\n"
        "┃ ❌ No unauthorized photos\n"
        "┃ ⚠️ 3 warnings \\= instant ban\n\n"
        "Enjoy your stay\\! 🎉"
    ),
    "elite": (
        "⚡ *\\[ ELITE ACCESS GRANTED \\]* ⚡\n\n"
        "Welcome {user} to *{group}*\n\n"
        "🔥 This is an elite\\-protected zone\\.\n"
        "🛡️ ShieldGuard Pro is actively monitoring\\.\n\n"
        "⚡ *Protected by:*\n"
        "┣ 🔗 Anti\\-Link Shield\n"
        "┣ 📸 Anti\\-Photo Guard\n"
        "┣ 🚫 Anti\\-Mention Wall\n"
        "┣ 🌊 Anti\\-Flood Barrier\n"
        "┗ ⚠️ Strike System \\(3 \\= Ban\\)\n\n"
        "Welcome aboard\\! 🚀"
    ),
    "minimal": (
        "👋 Welcome {user} to *{group}*\\!\n"
        "🛡️ Protected by ShieldGuard Pro\n"
        "⚠️ 3 warnings \\= ban\\. No links or spam\\."
    ),
    "gaming": (
        "🎮 *PLAYER JOINED THE LOBBY* 🎮\n\n"
        "👤 {user} has entered *{group}*\n\n"
        "🛡️ *Active Buffs:*\n"
        "┣ 🔗 Link Shield \\[LVL MAX\\]\n"
        "┣ 📸 Photo Block \\[LVL MAX\\]\n"
        "┣ 🚫 Mention Wall \\[LVL MAX\\]\n"
        "┣ 🌊 Flood Guard \\[LVL MAX\\]\n"
        "┗ ⚠️ Ban Hammer \\[3 STRIKES\\]\n\n"
        "Good luck, have fun\\! 🎲"
    ),
}


def get_welcome_text(template_name: str, user_name: str, group_name: str) -> str:
    template = WELCOME_TEMPLATES.get(template_name, WELCOME_TEMPLATES["default"])
    return template.format(user=user_name, group=group_name)


# ─── Command Handlers ─────────────────────────────────────────────────────────

async def start_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle /start command."""
    if update.effective_chat.type == "private":
        await update.message.reply_text(
            "🛡️ *ShieldGuard Bot — Premium Group Protection*\n\n"
            "Add me to your group and make me admin to activate all protection features automatically!\n\n"
            "🔹 Anti-Link (Telegram, WhatsApp, URLs)\n"
            "🔹 Anti-@Mention\n"
            "🔹 Anti-Photo\n"
            "🔹 Anti-Forward\n"
            "🔹 Anti-Flood\n"
            "🔹 Warn System (3 = Ban)\n"
            "🔹 Premium Welcome Messages\n\n"
            "Use /help to see all commands.",
            parse_mode=ParseMode.MARKDOWN,
        )
    else:
        await update.message.reply_text(
            "🛡️ ShieldGuard is active! Use /help to see commands.",
        )


async def help_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle /help command."""
    help_text = (
        "🛡️ *ShieldGuard Bot — Command List*\n\n"
        "📌 *User Commands:*\n"
        "┣ /start — Start the bot\n"
        "┣ /help — Show this message\n"
        "┣ /warnings — Check your warnings\n"
        "┗ /stats — Group protection stats\n\n"
        "👑 *Admin Commands:*\n"
        "┣ /settings — Toggle protection features\n"
        "┣ /resetwarns — Reset a user's warnings\n"
        "┣ /setwelcome — Set welcome template\n"
        "┣ /warn — Manually warn a user\n"
        "┣ /unwarn — Remove one warning\n"
        "┗ /ban — Ban a user\n\n"
        "⚙️ *Auto-Active Features (when bot is admin):*\n"
        "┣ 🔗 Anti-Link\n"
        "┣ 📸 Anti-Photo\n"
        "┣ 🚫 Anti-@Mention\n"
        "┣ ↔️ Anti-Forward\n"
        "┣ 🌊 Anti-Flood\n"
        "┗ 🎉 Welcome Messages"
    )
    await update.message.reply_text(help_text, parse_mode=ParseMode.MARKDOWN)


@group_only
async def warnings_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Check warnings for yourself or a replied-to user."""
    chat_id = update.effective_chat.id

    if update.message.reply_to_message:
        target = update.message.reply_to_message.from_user
    else:
        target = update.effective_user

    warn_count = store.get_warns(chat_id, target.id)
    remaining = MAX_WARNS - warn_count

    await update.message.reply_text(
        f"⚠️ *Warnings for {target.mention_markdown_v2()}:*\n"
        f"📌 {warn_count}/{MAX_WARNS} warnings\n"
        f"💀 {remaining} remaining before ban",
        parse_mode=ParseMode.MARKDOWN_V2,
    )


@group_only
@admin_only
async def resetwarns_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Reset warnings for a replied-to user."""
    if not update.message.reply_to_message:
        await update.message.reply_text("⚠️ Reply to a user's message to reset their warnings.")
        return

    target = update.message.reply_to_message.from_user
    store.reset_warns(update.effective_chat.id, target.id)
    await update.message.reply_text(
        f"✅ Warnings reset for {target.mention_markdown_v2()}",
        parse_mode=ParseMode.MARKDOWN_V2,
    )


@group_only
@admin_only
async def warn_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Manually warn a user (reply to their message)."""
    if not update.message.reply_to_message:
        await update.message.reply_text("⚠️ Reply to a user's message to warn them.")
        return

    target = update.message.reply_to_message.from_user
    reason = " ".join(context.args) if context.args else "Manual admin warning"

    warn_count = store.add_warn(update.effective_chat.id, target.id)
    store.bump_stat(update.effective_chat.id, "warns")
    remaining = MAX_WARNS - warn_count

    if warn_count >= MAX_WARNS:
        try:
            await context.bot.ban_chat_member(update.effective_chat.id, target.id)
            store.bump_stat(update.effective_chat.id, "bans")
            store.reset_warns(update.effective_chat.id, target.id)
            await update.message.reply_text(
                f"🚫 *{target.mention_markdown_v2()}* has been *BANNED* after {MAX_WARNS} warnings\!",
                parse_mode=ParseMode.MARKDOWN_V2,
            )
        except Exception as e:
            await update.message.reply_text(f"⚠️ Failed to ban: {e}")
    else:
        await update.message.reply_text(
            f"⚠️ *Warning {warn_count}/{MAX_WARNS}* for {target.mention_markdown_v2()}\n"
            f"📌 Reason: {reason}\n"
            f"💀 {remaining} more until ban",
            parse_mode=ParseMode.MARKDOWN_V2,
        )


@group_only
@admin_only
async def unwarn_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Remove one warning from a user."""
    if not update.message.reply_to_message:
        await update.message.reply_text("⚠️ Reply to a user's message to remove a warning.")
        return

    target = update.message.reply_to_message.from_user
    chat_id = update.effective_chat.id
    current = store.get_warns(chat_id, target.id)

    if current <= 0:
        await update.message.reply_text("✅ This user has no warnings.")
        return

    cid, uid = str(chat_id), str(target.id)
    store.data["warns"][cid][uid] = current - 1
    store.save()

    new_count = current - 1
    await update.message.reply_text(
        f"✅ Removed 1 warning from {target.mention_markdown_v2()}\n"
        f"📌 Now at {new_count}/{MAX_WARNS}",
        parse_mode=ParseMode.MARKDOWN_V2,
    )


@group_only
@admin_only
async def ban_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Ban a user (reply to their message)."""
    if not update.message.reply_to_message:
        await update.message.reply_text("⚠️ Reply to a user's message to ban them.")
        return

    target = update.message.reply_to_message.from_user
    reason = " ".join(context.args) if context.args else "Admin ban"

    try:
        await context.bot.ban_chat_member(update.effective_chat.id, target.id)
        store.bump_stat(update.effective_chat.id, "bans")
        store.reset_warns(update.effective_chat.id, target.id)
        await update.message.reply_text(
            f"🔨 *{target.mention_markdown_v2()}* has been *BANNED*\n📌 Reason: {reason}",
            parse_mode=ParseMode.MARKDOWN_V2,
        )
    except Exception as e:
        await update.message.reply_text(f"⚠️ Failed to ban: {e}")


@group_only
@admin_only
async def settings_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Show settings panel with toggle buttons."""
    group = store.get_group(update.effective_chat.id)

    features = [
        ("anti_link", "🔗 Anti-Link"),
        ("anti_mention", "🚫 Anti-@Mention"),
        ("anti_photo", "📸 Anti-Photo"),
        ("anti_forward", "↔️ Anti-Forward"),
        ("anti_flood", "🌊 Anti-Flood"),
        ("anti_sticker", "🎭 Anti-Sticker"),
        ("welcome_enabled", "🎉 Welcome"),
    ]

    buttons = []
    for key, label in features:
        status = "✅" if group.get(key, True) else "❌"
        buttons.append(
            [InlineKeyboardButton(f"{status} {label}", callback_data=f"toggle_{key}")]
        )

    # Welcome template selector
    buttons.append(
        [InlineKeyboardButton("📝 Set Welcome Template", callback_data="welcome_menu")]
    )

    keyboard = InlineKeyboardMarkup(buttons)

    active_status = "🟢 ACTIVE" if group.get("active") else "🔴 INACTIVE (need admin)"
    text = (
        f"🛡️ *ShieldGuard Settings*\n"
        f"Status: {active_status}\n\n"
        f"Toggle features below:"
    )

    await update.message.reply_text(
        text, parse_mode=ParseMode.MARKDOWN, reply_markup=keyboard
    )


async def settings_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle settings toggle callbacks."""
    query = update.callback_query
    await query.answer()

    chat_id = query.message.chat.id
    user_id = query.from_user.id

    # Only admins can change settings
    if not await is_admin(chat_id, user_id, context):
        await query.answer("🚫 Admin only!", show_alert=True)
        return

    data = query.data

    if data.startswith("toggle_"):
        key = data.replace("toggle_", "")
        group = store.get_group(chat_id)
        new_val = not group.get(key, True)
        store.update_group(chat_id, key, new_val)

        # Rebuild the keyboard
        group = store.get_group(chat_id)
        features = [
            ("anti_link", "🔗 Anti-Link"),
            ("anti_mention", "🚫 Anti-@Mention"),
            ("anti_photo", "📸 Anti-Photo"),
            ("anti_forward", "↔️ Anti-Forward"),
            ("anti_flood", "🌊 Anti-Flood"),
            ("anti_sticker", "🎭 Anti-Sticker"),
            ("welcome_enabled", "🎉 Welcome"),
        ]

        buttons = []
        for fkey, label in features:
            status = "✅" if group.get(fkey, True) else "❌"
            buttons.append(
                [InlineKeyboardButton(f"{status} {label}", callback_data=f"toggle_{fkey}")]
            )
        buttons.append(
            [InlineKeyboardButton("📝 Set Welcome Template", callback_data="welcome_menu")]
        )

        keyboard = InlineKeyboardMarkup(buttons)
        active_status = "🟢 ACTIVE" if group.get("active") else "🔴 INACTIVE (need admin)"

        await query.edit_message_text(
            f"🛡️ *ShieldGuard Settings*\nStatus: {active_status}\n\nToggle features below:",
            parse_mode=ParseMode.MARKDOWN,
            reply_markup=keyboard,
        )

    elif data == "welcome_menu":
        templates = [
            ("default", "🌟 Default (Premium)"),
            ("elite", "⚡ Elite"),
            ("minimal", "📌 Minimal"),
            ("gaming", "🎮 Gaming"),
        ]
        buttons = []
        for tid, tlabel in templates:
            buttons.append(
                [InlineKeyboardButton(tlabel, callback_data=f"welcome_{tid}")]
            )
        buttons.append(
            [InlineKeyboardButton("🔙 Back", callback_data="back_settings")]
        )
        await query.edit_message_text(
            "📝 *Select a welcome message template:*",
            parse_mode=ParseMode.MARKDOWN,
            reply_markup=InlineKeyboardMarkup(buttons),
        )

    elif data.startswith("welcome_"):
        template = data.replace("welcome_", "")
        store.update_group(chat_id, "welcome_text", template)
        await query.edit_message_text(
            f"✅ Welcome template set to *{template}*!\n\n"
            f"New members will see the new welcome message\\.",
            parse_mode=ParseMode.MARKDOWN_V2,
        )

    elif data == "back_settings":
        group = store.get_group(chat_id)
        features = [
            ("anti_link", "🔗 Anti-Link"),
            ("anti_mention", "🚫 Anti-@Mention"),
            ("anti_photo", "📸 Anti-Photo"),
            ("anti_forward", "↔️ Anti-Forward"),
            ("anti_flood", "🌊 Anti-Flood"),
            ("anti_sticker", "🎭 Anti-Sticker"),
            ("welcome_enabled", "🎉 Welcome"),
        ]

        buttons = []
        for fkey, label in features:
            status = "✅" if group.get(fkey, True) else "❌"
            buttons.append(
                [InlineKeyboardButton(f"{status} {label}", callback_data=f"toggle_{fkey}")]
            )
        buttons.append(
            [InlineKeyboardButton("📝 Set Welcome Template", callback_data="welcome_menu")]
        )

        keyboard = InlineKeyboardMarkup(buttons)
        active_status = "🟢 ACTIVE" if group.get("active") else "🔴 INACTIVE (need admin)"

        await query.edit_message_text(
            f"🛡️ *ShieldGuard Settings*\nStatus: {active_status}\n\nToggle features below:",
            parse_mode=ParseMode.MARKDOWN,
            reply_markup=keyboard,
        )


@group_only
async def stats_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Show group protection stats."""
    chat_id = update.effective_chat.id
    stats = store.data["stats"].get(str(chat_id), {
        "deletes": 0, "warns": 0, "bans": 0, "welcomes": 0
    })
    group = store.get_group(chat_id)

    active_status = "🟢 ACTIVE" if group.get("active") else "🔴 INACTIVE"

    await update.message.reply_text(
        f"📊 *ShieldGuard Stats — {update.effective_chat.title}*\n\n"
        f"🛡️ Status: {active_status}\n"
        f"🗑️ Messages Deleted: {stats.get('deletes', 0)}\n"
        f"⚠️ Warnings Issued: {stats.get('warns', 0)}\n"
        f"🔨 Users Banned: {stats.get('bans', 0)}\n"
        f"👋 Welcomes Sent: {stats.get('welcomes', 0)}\n\n"
        f"⚙️ *Active Protections:*\n"
        f"┣ 🔗 Anti-Link: {'✅' if group.get('anti_link') else '❌'}\n"
        f"┣ 🚫 Anti-@Mention: {'✅' if group.get('anti_mention') else '❌'}\n"
        f"┣ 📸 Anti-Photo: {'✅' if group.get('anti_photo') else '❌'}\n"
        f"┣ ↔️ Anti-Forward: {'✅' if group.get('anti_forward') else '❌'}\n"
        f"┣ 🌊 Anti-Flood: {'✅' if group.get('anti_flood') else '❌'}\n"
        f"┗ 🎭 Anti-Sticker: {'✅' if group.get('anti_sticker') else '❌'}",
        parse_mode=ParseMode.MARKDOWN,
    )


# ─── Chat Member Handler (Auto-activate when bot becomes admin) ───────────────

async def on_chat_member_update(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Detect when bot is added/made admin and auto-activate features."""
    result = update.chat_member
    if not result or not result.new_chat_member:
        return

    bot_id = (await context.bot.get_me()).id
    new_member = result.new_chat_member

    # Check if the bot's status changed
    if new_member.user.id == bot_id:
        chat_id = result.chat.id
        if new_member.status in (ChatMemberStatus.ADMINISTRATOR, ChatMemberStatus.OWNER):
            store.update_group(chat_id, "active", True)
            try:
                await context.bot.send_message(
                    chat_id,
                    "🛡️ *ShieldGuard Pro Activated\\!* \n\n"
                    "✅ All protection features are now *ACTIVE*\\.\n\n"
                    "🔗 Anti\\-Link • 📸 Anti\\-Photo • 🚫 Anti\\-Mention\n"
                    "↔️ Anti\\-Forward • 🌊 Anti\\-Flood • ⚠️ Warn System\n\n"
                    "Use /settings to customize features\\.\n"
                    "Use /help to see all commands\\.",
                    parse_mode=ParseMode.MARKDOWN_V2,
                )
            except Exception as e:
                logger.error(f"Failed to send activation message: {e}")
        else:
            store.update_group(chat_id, "active", False)


# ─── Welcome Handler (New Members) ────────────────────────────────────────────

async def greet_new_members(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Send premium welcome message when new members join."""
    if not update.message.new_chat_members:
        return

    chat_id = update.effective_chat.id
    group = store.get_group(chat_id)

    if not group.get("welcome_enabled", True):
        return

    group_name = update.effective_chat.title or "this group"
    template = group.get("welcome_text", "default")

    for member in update.message.new_chat_members:
        bot_id = (await context.bot.get_me()).id
        if member.id == bot_id:
            continue  # Don't welcome the bot itself

        user_name = member.mention_markdown_v2() if member.username else member.first_name
        # Escape group name for MarkdownV2
        safe_group = group_name.replace("_", "\\_").replace("*", "\\*").replace("[", "\\[").replace("]", "\\]").replace("(", "\\(").replace(")", "\\)").replace("~", "\\~").replace("`", "\\`").replace(">", "\\>").replace("#", "\\#").replace("+", "\\+").replace("-", "\\-").replace("=", "\\=").replace("|", "\\|").replace("{", "\\{").replace("}", "\\}").replace(".", "\\.").replace("!", "\\!")

        welcome = get_welcome_text(template, user_name, safe_group)
        try:
            await update.effective_chat.send_message(
                welcome, parse_mode=ParseMode.MARKDOWN_V2
            )
            store.bump_stat(chat_id, "welcomes")
        except Exception as e:
            logger.error(f"Failed to send welcome: {e}")


# ─── Message Protection Handlers ──────────────────────────────────────────────

async def protect_messages(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Main handler: check all messages for violations."""
    if not update.message:
        return
    if not update.effective_chat or update.effective_chat.type == "private":
        return
    if not update.effective_user:
        return

    chat_id = update.effective_chat.id
    user_id = update.effective_user.id
    group = store.get_group(chat_id)

    # Skip if bot is not admin (protection not active)
    if not group.get("active", False):
        return

    # Skip admins — they are exempt from all protections
    if await is_admin(chat_id, user_id, context):
        return

    text = update.message.text or update.message.caption or ""
    deleted = False
    reason = ""

    # ── Anti-Link ─────────────────────────────────────────────────────
    if group.get("anti_link", True) and not deleted:
        if contains_link(text):
            reason = "🔗 Sending links is not allowed"
            try:
                await update.message.delete()
                deleted = True
                store.bump_stat(chat_id, "deletes")
            except Exception:
                pass

    # ── Anti-@Mention ─────────────────────────────────────────────────
    if group.get("anti_mention", True) and not deleted:
        if contains_mention(text):
            reason = "🚫 @mentioning users is not allowed"
            try:
                await update.message.delete()
                deleted = True
                store.bump_stat(chat_id, "deletes")
            except Exception:
                pass

    # ── Anti-Photo ────────────────────────────────────────────────────
    if group.get("anti_photo", True) and not deleted:
        if update.message.photo:
            reason = "📸 Sending photos is not allowed"
            try:
                await update.message.delete()
                deleted = True
                store.bump_stat(chat_id, "deletes")
            except Exception:
                pass

    # ── Anti-Forward ──────────────────────────────────────────────────
    if group.get("anti_forward", True) and not deleted:
        if update.message.forward_date:
            reason = "↔️ Forwarded messages are not allowed"
            try:
                await update.message.delete()
                deleted = True
                store.bump_stat(chat_id, "deletes")
            except Exception:
                pass

    # ── Anti-Sticker ──────────────────────────────────────────────────
    if group.get("anti_sticker", False) and not deleted:
        if update.message.sticker or update.message.animation:
            reason = "🎭 Stickers/GIFs are not allowed"
            try:
                await update.message.delete()
                deleted = True
                store.bump_stat(chat_id, "deletes")
            except Exception:
                pass

    # ── Anti-Flood ────────────────────────────────────────────────────
    if group.get("anti_flood", True) and not deleted:
        if store.check_flood(chat_id, user_id):
            reason = "🌊 Flooding — sending too many messages"
            try:
                await update.message.delete()
                deleted = True
                store.bump_stat(chat_id, "deletes")
            except Exception:
                pass

    # ── Warn the user if a message was deleted ────────────────────────
    if deleted and reason:
        await warn_user(update, context, reason)


# ─── Error Handler ────────────────────────────────────────────────────────────

async def error_handler(update: object, context: ContextTypes.DEFAULT_TYPE):
    """Log errors."""
    logger.error(f"Exception while handling an update: {context.error}")


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    """Start the bot."""
    logger.info("🛡️ ShieldGuard Bot starting...")

    app = ApplicationBuilder().token(BOT_TOKEN).build()

    # Command handlers
    app.add_handler(CommandHandler("start", start_cmd))
    app.add_handler(CommandHandler("help", help_cmd))
    app.add_handler(CommandHandler("warnings", warnings_cmd))
    app.add_handler(CommandHandler("resetwarns", resetwarns_cmd))
    app.add_handler(CommandHandler("warn", warn_cmd))
    app.add_handler(CommandHandler("unwarn", unwarn_cmd))
    app.add_handler(CommandHandler("ban", ban_cmd))
    app.add_handler(CommandHandler("settings", settings_cmd))
    app.add_handler(CommandHandler("stats", stats_cmd))

    # Callback query handler (settings toggles)
    app.add_handler(CallbackQueryHandler(settings_callback))

    # Chat member handler (detect when bot becomes admin)
    app.add_handler(ChatMemberHandler(on_chat_member_update, ChatMemberHandler.CHAT_MEMBER))

    # Welcome new members
    app.add_handler(MessageHandler(filters.StatusUpdate.NEW_CHAT_MEMBERS, greet_new_members))

    # Protection handler — all non-command, non-service messages
    app.add_handler(
        MessageHandler(
            filters.ALL & ~filters.COMMAND & ~filters.StatusUpdate.ALL,
            protect_messages,
        )
    )

    # Error handler
    app.add_error_handler(error_handler)

    logger.info("🛡️ ShieldGuard Bot is running!")
    app.run_polling(drop_pending_updates=True)


if __name__ == "__main__":
    main()
