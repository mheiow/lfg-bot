# OW2 LFG — Ephemeral Embeds (No DMs)

- Host runs `/lfg` and goes through an **ephemeral** wizard (only they see it).
- The public LFG post appears **only after confirm**.
- Joiners click **buttons** on the public post; their join wizard also runs **ephemerally**.
- Public post updates to show joiners; no DMs used.

## Commands
- `/lfg_set_channel <#channel>` — owner only
- `/lfg_set_options [region_strict] [allow_threads]`
- `/lfg_info`
- `/lfg`

## Deploy (Koyeb)
- Push these files to a GitHub repo (root). Create Web Service → Dockerfile build.
- Env var: `DISCORD_TOKEN`.
