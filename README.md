# ShieldGuard Bot 🛡️

Premium Telegram Group Protection Bot

## Features

- 🔗 **Anti-Link** — Deletes Telegram links, WhatsApp links, and all URLs
- 🚫 **Anti-@Mention** — Deletes messages containing @username tags
- 📸 **Anti-Photo** — Deletes photos sent by non-admins
- ↔️ **Anti-Forward** — Deletes forwarded messages
- 🌊 **Anti-Flood** — Rate limits spam messages
- 🎭 **Anti-Sticker** — Optionally block stickers/GIFs (off by default)
- ⚠️ **Warn System** — 3 warnings = automatic ban
- 🎉 **Premium Welcome Messages** — 4 templates (Default, Elite, Minimal, Gaming)
- 🟢 **Auto-Activate** — All features activate when bot is made admin
- ⚙️ **Toggle Settings** — Admins can enable/disable features via /settings
- 📊 **Group Stats** — Track deletions, warnings, bans, welcomes

## Deploy to Render

1. Push these files to a GitHub repository
2. Go to [render.com](https://render.com) → New → Web Service (or Background Worker)
3. Connect your GitHub repo
4. Set the following:
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:** `python bot.py`
   - **Environment Variable:** `BOT_TOKEN` = your bot token
5. Deploy!

Alternatively, use the included `render.yaml` for Blueprint deployment.

## Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Start the bot |
| `/help` | Show all commands |
| `/warnings` | Check your warnings |
| `/stats` | Group protection stats |
| `/settings` | Toggle features (admin) |
| `/warn` | Warn a user (admin) |
| `/unwarn` | Remove a warning (admin) |
| `/resetwarns` | Reset user warnings (admin) |
| `/ban` | Ban a user (admin) |
| `/setwelcome` | Set welcome template (via /settings) |

## Setup

1. Add the bot to your Telegram group
2. Promote the bot to **Admin** with **Delete Messages** and **Ban Users** permissions
3. All protection features activate automatically!
4. Use `/settings` to customize which features are active
