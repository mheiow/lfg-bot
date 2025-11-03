# OW2 LFG Discord Bot (Node.js + Slash) — Koyeb‑friendly Dockerfile

This package is identical to the previous slash‑commands build, but with a **simplified Dockerfile** that works cleanly on **Koyeb**.

## Deploy (Koyeb Free)

1. Push to GitHub (root must contain `Dockerfile`, `index.js`, `package.json`).
2. Create Web Service → build with **Dockerfile**.
3. Env var: `DISCORD_TOKEN` = your bot token.
4. Select the **free** instance + region → Deploy.
5. In Discord: `/lfg_set_channel #lfg`, then `/lfg`.

## Local run
```bash
npm install
export DISCORD_TOKEN=your-bot-token
node index.js
```

### Commands
- `/lfg` — start wizard (only in configured channel)
- `/lfg_set_channel <#channel>` — owner only
- `/lfg_clear_channel` — owner only
- `/lfg_info`
- `/lfg_set_options [region_strict] [allow_threads]`
