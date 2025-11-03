# OW2 LFG — Pro Build (Ephemeral)

**What’s included**
- Ephemeral host wizard → **Final Confirmation** (Post / Edit / Cancel)
- Public post with **Join / Leave / Remove Player** buttons (no DMs)
- **Auto-expiration** (1h / 2h / 3h choices)
- **Cleaner embeds** (role/region/platform icons, rank colors)
- **Open Queue vs Role Queue** enforcement
- **Cross-region** choice (strict vs allow) in setup
- **Platform** step (PC / Console / Any) for host + joiners
- **Auto team thread** when group becomes **FULL**
- **@lfg** ping on post (if a role named `lfg` exists)
- **LFG logging** to a chosen channel (`/lfg_set_log_channel`)
- Error-proofing: missing config/perms messages, no stale button reuse (scoped IDs)

## Commands
- `/lfg_set_channel <#channel>` — owner only
- `/lfg_set_log_channel <#channel>` — owner only
- `/lfg_info` — show config
- `/lfg` — start
