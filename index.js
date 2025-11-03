/* eslint-disable no-console */
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  PermissionsBitField,
  SlashCommandBuilder,
  ChannelType
} = require('discord.js');
const express = require('express');
require('dotenv').config();

const TOKEN = process.env.DISCORD_TOKEN;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User, Partials.GuildMember]
});

// Emojis
const EMOJI_LEFT = '◀️';
const EMOJI_RIGHT = '▶️';
const EMOJI_CONFIRM = '✅';
const EMOJI_CANCEL = '❌';
const EMOJI_SKIP = '🚫';

const NUMS = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣'];

const EMOJI_ROLE_TANK = '🛡️';
const EMOJI_ROLE_DAMAGE = '⚔️';
const EMOJI_ROLE_SUPPORT = '✨';
const EMOJI_ROLE_FLEX = '🔁';

const EMOJI_MODE_COMP_ROLE = '🏆';
const EMOJI_MODE_COMP_OPEN = '🔓';
const EMOJI_MODE_QP_ROLE = '🎮';
const EMOJI_MODE_QP_OPEN = '👐';
const EMOJI_MODE_ARCADE = '🎲';
const EMOJI_MODE_CUSTOM = '🏟️';

const RANKS = ['bronze','silver','gold','platinum','diamond','master','grandmaster','champion'];
const REGIONS = ['NA','EU','APAC','LATAM','OCE','ME','AFR'];

const HEROES = {
  tank: [
    'd.va','doomfist','junker queen','orisa','ramattra','reinhardt',
    'roadhog','sigma','winston','wrecking ball','zarya','mauga'
  ],
  damage: [
    'ashe','bastion','cassidy','echo','genji','hanzo','junkrat',
    'mei','pharah','reaper','sojourn','soldier: 76','sombra',
    'symmetra','torbjorn','tracer','widowmaker','venture'
  ],
  support: [
    'ana','baptiste','brigitte','illari','kiriko','lifeweaver',
    'lucio','mercy','moira','zenyatta'
  ]
};

const HERO_ALIASES = {
  'dva': 'd.va',
  'wreckingball': 'wrecking ball',
  'soldier 76': 'soldier: 76',
  'soldier:76': 'soldier: 76',
  'torbjörn': 'torbjorn',
  'lúcio': 'lucio'
};

const GUILD_CONFIGS = new Map();  // guildId -> { channelId, strictRegion, allowThreads }
const ACTIVE_POSTS = new Map();   // messageId -> session

function heroesForRole(role) {
  if (role && HEROES[role]) return HEROES[role];
  const s = new Set();
  for (const lst of Object.values(HEROES)) for (const h of lst) s.add(h);
  return Array.from(s).sort();
}
function isHeroRoleObj(roleObj) {
  const name = roleObj.name.trim().toLowerCase();
  const n = HERO_ALIASES[name] || name;
  for (const lst of Object.values(HEROES)) if (lst.includes(n)) return n;
  return null;
}
function detectGuildHeroRoles(guild) {
  const out = {};
  guild.roles.cache.forEach(r => {
    const canon = isHeroRoleObj(r);
    if (canon) out[canon] = r;
  });
  return out;
}
async function addManyReactions(msg, emojis) { for (const e of emojis) { try { await msg.react(e); } catch {} } }
const emojiKey = (e) => e?.name ?? e?.toString();
async function awaitReaction(userId, message, valid, timeoutMs = 90_000) {
  try {
    const filter = (reaction, user) => user.id === userId && valid.includes(emojiKey(reaction.emoji));
    const collected = await message.awaitReactions({ filter, max: 1, time: timeoutMs, errors: ['time'] });
    const first = collected.first();
    return emojiKey(first?.emoji);
  } catch { return null; }
}
const gamemodeLabel = (m) => ({
  comp_role: 'Competitive (Role Queue)',
  comp_open: 'Competitive (Open Queue)',
  qp_role: 'Quick Play (Role Queue)',
  qp_open: 'Quick Play (Open Queue)',
  arcade: 'Arcade',
  custom: 'Custom Game'
}[m] || 'Unknown');
const roleLabel = (r) => ({ tank: 'Tank', damage: 'Damage', support: 'Support', flex: 'Flex (any role)' }[r] || 'Unknown');
const isCompetitive = (s) => s.mode === 'comp_role' || s.mode === 'comp_open';

function buildSummaryEmbed(session, authorMember) {
  const e = new EmbedBuilder()
    .setTitle(`LFG • ${gamemodeLabel(session.mode)}`)
    .setColor(0x5865F2)
    .setAuthor({ name: authorMember.displayName, iconURL: authorMember.displayAvatarURL() });
  const setupLines = [
    `**Role**: ${roleLabel(session.role)}`,
    `**Hero**: ${session.hero ?? 'any'}`,
    `**Region**: ${session.region ?? '?'}`,
    `**Mic**: ${session.micRequired ? 'required' : 'optional'}`,
    `**Players needed**: ${session.playersNeeded}`
  ].join('\n');
  e.addFields({ name: 'Setup', value: setupLines });
  if (isCompetitive(session)) {
    const rr = `${session.compRankMin ?? '?'} — ${session.compRankMax ?? '?'}`;
    e.addFields({ name: 'Competitive Preferences', value: `**Rank range**: ${rr}` });
  }
  return e;
}
function buildListingEmbed(session, authorMember, guild) {
  const joinNames = [];
  for (const j of session.joiners) {
    const member = guild.members.cache.get(j.userId);
    if (!member) continue;
    const bits = [];
    if (j.role) bits.push(j.role[0].toUpperCase() + j.role.slice(1));
    if (j.hero) bits.push(j.hero);
    if (isCompetitive(session) && j.rank) bits.push(j.rank[0].toUpperCase() + j.rank.slice(1));
    if (j.region) bits.push(j.region);
    const tag = bits.length ? bits.join(', ') : 'joined';
    joinNames.push(`- ${member} (${tag})`);
  }
  const joinedText = joinNames.length ? joinNames.join('\n') : '*No joiners yet.*';
  const e = buildSummaryEmbed(session, authorMember);
  e.addFields({ name: 'Joiners', value: joinedText });
  if (session.joiners.length >= session.playersNeeded) {
    e.setColor(0x57F287);
    e.setDescription('**Status: FULL**');
  } else {
    e.setDescription(`React with ${EMOJI_CONFIRM} to join • ${EMOJI_CANCEL} to leave • ▶️ to open a team thread`);
  }
  return e;
}
const makeSession = (guildId, authorId) => ({
  guildId, authorId, mode: null, role: null, hero: null,
  compRankMin: null, compRankMax: null, region: null,
  micRequired: false, playersNeeded: 4,
  listingMessageId: null, listingChannelId: null, joiners: []
});
function getLfgChannel(guild) {
  const cfg = GUILD_CONFIGS.get(guild.id);
  if (cfg?.channelId) {
    const ch = guild.channels.cache.get(cfg.channelId);
    if (ch?.isTextBased() && ch.viewable && ch.permissionsFor(guild.members.me).has(PermissionsBitField.Flags.SendMessages)) return ch;
  }
  throw new Error('LFG channel is not configured. Use /lfg_set_channel first.');
}

// Slash commands
const slashData = [
  new (require('discord.js').SlashCommandBuilder)().setName('lfg').setDescription('Start the LFG wizard (allowed channel only)'),
  new (require('discord.js').SlashCommandBuilder)().setName('lfg_set_channel').setDescription('Owner only: set the single channel for /lfg').addChannelOption(opt=>opt.setName('channel').setDescription('Text channel').addChannelTypes(0).setRequired(true)),
  new (require('discord.js').SlashCommandBuilder)().setName('lfg_clear_channel').setDescription('Owner only: clear channel'),
  new (require('discord.js').SlashCommandBuilder)().setName('lfg_info').setDescription('Show current LFG config'),
  new (require('discord.js').SlashCommandBuilder)().setName('lfg_set_options').setDescription('Owner only: set options').addBooleanOption(o=>o.setName('region_strict').setDescription('Require joiners to match region')).addBooleanOption(o=>o.setName('allow_threads').setDescription('Create a thread for setup/listing'))
].map(c => c.toJSON());

async function registerGuildCommands(guild){ try{ await guild.commands.set(slashData); console.log(`[slash] Registered for ${guild.name}`);}catch(e){ console.error('slash register failed', e);}}

client.once('ready', async ()=>{
  console.log(`Logged in as ${client.user.tag}`);
  for (const [,g] of client.guilds.cache) {
    await registerGuildCommands(g);
    if (!GUILD_CONFIGS.has(g.id)) GUILD_CONFIGS.set(g.id, { channelId: null, strictRegion: true, allowThreads: true });
  }
});
client.on('guildCreate', async (g)=>{ await registerGuildCommands(g); GUILD_CONFIGS.set(g.id,{ channelId:null, strictRegion:true, allowThreads:true}); });

client.on('interactionCreate', async (interaction)=>{
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.inGuild()) return void interaction.reply({ content:'Use this in a server.', ephemeral:true });
  const ownerId = interaction.guild.ownerId;
  const cfg = GUILD_CONFIGS.get(interaction.guild.id) || { channelId:null, strictRegion:true, allowThreads:true };

  try {
    if (interaction.commandName === 'lfg_set_channel') {
      if (interaction.user.id !== ownerId) return void interaction.reply({ content:'Only the **server owner** can run this.', ephemeral:true });
      const ch = interaction.options.getChannel('channel', true);
      if (ch.type !== 0) return void interaction.reply({ content:'Pick a **text channel**.', ephemeral:true });
      GUILD_CONFIGS.set(interaction.guild.id, { ...cfg, channelId: ch.id });
      return void interaction.reply({ content:`✅ LFG channel set to ${ch}. /lfg will only work there.`, ephemeral:true });
    }
    if (interaction.commandName === 'lfg_clear_channel') {
      if (interaction.user.id !== ownerId) return void interaction.reply({ content:'Only the **server owner** can run this.', ephemeral:true });
      GUILD_CONFIGS.set(interaction.guild.id, { ...cfg, channelId: null });
      return void interaction.reply({ content:'✅ LFG channel cleared.', ephemeral:true });
    }
    if (interaction.commandName === 'lfg_set_options') {
      if (interaction.user.id !== ownerId) return void interaction.reply({ content:'Only the **server owner** can run this.', ephemeral:true });
      const regionStrict = interaction.options.getBoolean('region_strict');
      const allowThreads = interaction.options.getBoolean('allow_threads');
      const next = { ...cfg };
      if (regionStrict !== null) next.strictRegion = regionStrict;
      if (allowThreads !== null) next.allowThreads = allowThreads;
      GUILD_CONFIGS.set(interaction.guild.id, next);
      return void interaction.reply({ content:`✅ Options updated: region_strict=${next.strictRegion?'on':'off'}, allow_threads=${next.allowThreads?'on':'off'}`, ephemeral:true });
    }
    if (interaction.commandName === 'lfg_info') {
      const chMention = cfg.channelId ? `<#${cfg.channelId}>` : '*(not set)*';
      const text = `**Configured channel**: ${chMention}\n**Region strict**: ${cfg.strictRegion?'on':'off'}\n**Allow threads**: ${cfg.allowThreads?'on':'off'}`;
      return void interaction.reply({ embeds:[ new EmbedBuilder().setTitle('LFG Configuration').setColor(0x5865F2).setDescription(text) ], ephemeral:true });
    }
    if (interaction.commandName === 'lfg') {
      if (!cfg.channelId) return void interaction.reply({ content:'❌ LFG channel not set. Ask the server owner to run **/lfg_set_channel** first.', ephemeral:true });
      if (interaction.channelId !== cfg.channelId) return void interaction.reply({ content:`❌ Use /lfg in the configured channel: <#${cfg.channelId}>`, ephemeral:true });
      await interaction.reply({ content:'Starting your LFG setup…', ephemeral:true });
      await startLfgWizard(interaction, cfg);
    }
  } catch (e) {
    console.error('interaction error', e);
    try { await interaction.reply({ content:'Something went wrong.', ephemeral:true }); } catch {}
  }
});

async function startLfgWizard(interaction, cfg) {
  const guild = interaction.guild;
  const authorMember = interaction.member;
  const channel = guild.channels.cache.get(cfg.channelId);
  const setupMsg = await channel.send({ content: `${authorMember} is setting up an LFG…` });
  let setupChannel = channel;
  if (cfg.allowThreads) {
    try { const thread = await setupMsg.startThread({ name:`LFG setup — ${authorMember.displayName}`, autoArchiveDuration:60 }); setupChannel = thread; } catch {}
  }
  const session = makeSession(guild.id, authorMember.id);

  // Step 1 Game mode
  const stepMsg = await setupChannel.send({ embeds:[ new EmbedBuilder().setTitle('Step 1 — Choose a game mode').setColor(0x5865F2).setDescription(
    `${EMOJI_MODE_COMP_ROLE} Competitive (Role Queue)\n${EMOJI_MODE_COMP_OPEN} Competitive (Open Queue)\n${EMOJI_MODE_QP_ROLE} Quick Play (Role Queue)\n${EMOJI_MODE_QP_OPEN} Quick Play (Open Queue)\n${EMOJI_MODE_ARCADE} Arcade\n${EMOJI_MODE_CUSTOM} Custom Game\n\nReact below to choose.`
  )]});
  const gmMap = { [EMOJI_MODE_COMP_ROLE]:'comp_role', [EMOJI_MODE_COMP_OPEN]:'comp_open', [EMOJI_MODE_QP_ROLE]:'qp_role', [EMOJI_MODE_QP_OPEN]:'qp_open', [EMOJI_MODE_ARCADE]:'arcade', [EMOJI_MODE_CUSTOM]:'custom' };
  await addManyReactions(stepMsg, Object.keys(gmMap));
  let choice = await awaitReaction(authorMember.id, stepMsg, Object.keys(gmMap));
  if (!choice) return void setupChannel.send('⏱️ Setup timed out. Run /lfg again.');
  session.mode = gmMap[choice];

  // Step 2 Role
  await stepMsg.reactions.removeAll().catch(()=>{});
  await stepMsg.edit({ embeds:[ new EmbedBuilder().setTitle('Step 2 — Choose your role (Role Queue)').setColor(0x5865F2).setDescription(
    `${EMOJI_ROLE_TANK} Tank\n${EMOJI_ROLE_DAMAGE} Damage\n${EMOJI_ROLE_SUPPORT} Support\n${EMOJI_ROLE_FLEX} Flex (any)\n\nReact below to choose.`
  )]});
  const roleMap = { [EMOJI_ROLE_TANK]:'tank', [EMOJI_ROLE_DAMAGE]:'damage', [EMOJI_ROLE_SUPPORT]:'support', [EMOJI_ROLE_FLEX]:'flex' };
  await addManyReactions(stepMsg, Object.keys(roleMap));
  choice = await awaitReaction(authorMember.id, stepMsg, Object.keys(roleMap));
  if (!choice) return void setupChannel.send('⏱️ Setup timed out. Run /lfg again.');
  session.role = roleMap[choice];

  // Step 3 Hero (paged)
  const allowedHeroes = heroesForRole(session.role !== 'flex' ? session.role : null);
  const roleBound = allowedHeroes.filter(h => detectGuildHeroRoles(guild)[h]);
  const displayHeroes = roleBound.length ? roleBound : allowedHeroes;
  let page = 0; const pageSize = 9;
  const heroPageEmbed = (pg) => {
    const start = pg * pageSize;
    const items = displayHeroes.slice(start, start + pageSize);
    const lines = items.map((h,i)=>`${NUMS[i]} ${h}`);
    return new EmbedBuilder().setTitle('Step 3 — Choose your hero').setColor(0x5865F2).setDescription(lines.length?lines.join('\n'):'*No hero roles detected; skipping is fine.*').setFooter({ text:'Pick with a number. ◀️ ▶️ to page, 🚫 to skip.' });
  };
  await stepMsg.reactions.removeAll().catch(()=>{});
  await stepMsg.edit({ embeds:[ heroPageEmbed(page) ] });
  const heroNav = [EMOJI_LEFT, ...NUMS, EMOJI_RIGHT, EMOJI_SKIP];
  await addManyReactions(stepMsg, heroNav);
  while (true) {
    choice = await awaitReaction(authorMember.id, stepMsg, heroNav);
    if (!choice) return void setupChannel.send('⏱️ Setup timed out. Run /lfg again.');
    if (choice === EMOJI_LEFT) { page=Math.max(0,page-1); await stepMsg.edit({ embeds:[heroPageEmbed(page)] }); continue; }
    if (choice === EMOJI_RIGHT) { const maxPg = Math.max(0, Math.floor((displayHeroes.length-1)/pageSize)); page = Math.min(maxPg, page+1); await stepMsg.edit({ embeds:[heroPageEmbed(page)] }); continue; }
    if (choice === EMOJI_SKIP) { session.hero=null; break; }
    if (NUMS.includes(choice)) { const idx=NUMS.indexOf(choice); const start=page*pageSize; const items=displayHeroes.slice(start,start+pageSize); session.hero = idx<items.length?items[idx]:null; break; }
  }

  // Step 4 Rank (if comp)
  if (isCompetitive(session)) {
    const rankLines = RANKS.map((r,i)=>`${NUMS[i]} ${r[0].toUpperCase()+r.slice(1)}`).join('\n');
    await stepMsg.reactions.removeAll().catch(()=>{});
    await stepMsg.edit({ embeds:[ new EmbedBuilder().setTitle('Step 4 — Competitive rank range').setColor(0x5865F2).setDescription(`**Pick your **minimum** rank preference**.\nThis is a *preference* to filter joiners.\n\n${rankLines}\n\nReact with a number.`) ]});
    await addManyReactions(stepMsg, NUMS.slice(0, RANKS.length));
    choice = await awaitReaction(authorMember.id, stepMsg, NUMS.slice(0, RANKS.length));
    if (!choice) return void setupChannel.send('⏱️ Setup timed out. Run /lfg again.');
    let rmin = RANKS[NUMS.indexOf(choice)];

    await stepMsg.reactions.removeAll().catch(()=>{});
    await stepMsg.edit({ embeds:[ new EmbedBuilder().setTitle('Step 4 — Competitive rank range').setColor(0x5865F2).setDescription(`**Minimum** set to **${rmin[0].toUpperCase()+rmin.slice(1)}**.\nNow pick your **maximum**.\n\n${rankLines}\n\nReact with a number.`) ]});
    await addManyReactions(stepMsg, NUMS.slice(0, RANKS.length));
    choice = await awaitReaction(authorMember.id, stepMsg, NUMS.slice(0, RANKS.length));
    if (!choice) return void setupChannel.send('⏱️ Setup timed out. Run /lfg again.');
    let rmax = RANKS[NUMS.indexOf(choice)];
    if (RANKS.indexOf(rmax) < RANKS.indexOf(rmin)) [rmin, rmax] = [rmax, rmin];
    session.compRankMin = rmin; session.compRankMax = rmax;
  }

  // Step 5 Region
  const regionLines = REGIONS.map((r,i)=>`${NUMS[i]} ${r}`).join('\n');
  await stepMsg.reactions.removeAll().catch(()=>{});
  await stepMsg.edit({ embeds:[ new EmbedBuilder().setTitle('Step 5 — Region').setColor(0x5865F2).setDescription(`Pick your **region**:\n\n${regionLines}\n\nReact with a number.`) ]});
  await addManyReactions(stepMsg, NUMS.slice(0, REGIONS.length));
  choice = await awaitReaction(authorMember.id, stepMsg, NUMS.slice(0, REGIONS.length));
  if (!choice) return void setupChannel.send('⏱️ Setup timed out. Run /lfg again.');
  session.region = REGIONS[NUMS.indexOf(choice)];

  // Step 6 Mic/size
  await stepMsg.reactions.removeAll().catch(()=>{});
  await stepMsg.edit({ embeds:[ new EmbedBuilder().setTitle('Step 6 — Mic & party size').setColor(0x5865F2).setDescription(`Toggle mic with ${EMOJI_CONFIRM} (on) / ${EMOJI_CANCEL} (off). Currently **off**.\nThen choose players needed with a number (1–4).`) ]});
  await addManyReactions(stepMsg, [EMOJI_CONFIRM, EMOJI_CANCEL, ...NUMS.slice(0,4)]);
  choice = await awaitReaction(authorMember.id, stepMsg, [EMOJI_CONFIRM, EMOJI_CANCEL]); if (!choice) return void setupChannel.send('⏱️ Setup timed out. Run /lfg again.');
  session.micRequired = (choice === EMOJI_CONFIRM);
  choice = await awaitReaction(authorMember.id, stepMsg, NUMS.slice(0,4)); if (!choice) return void setupChannel.send('⏱️ Setup timed out. Run /lfg again.');
  session.playersNeeded = NUMS.indexOf(choice)+1;

  // Confirm & post
  await stepMsg.reactions.removeAll().catch(()=>{});
  const summary = buildSummaryEmbed(session, authorMember).setFooter({ text:`React with ${EMOJI_CONFIRM} to post, or ${EMOJI_CANCEL} to cancel.` });
  await stepMsg.edit({ embeds:[summary] });
  await addManyReactions(stepMsg, [EMOJI_CONFIRM, EMOJI_CANCEL]);
  choice = await awaitReaction(authorMember.id, stepMsg, [EMOJI_CONFIRM, EMOJI_CANCEL]);
  if (choice !== EMOJI_CONFIRM) return void setupChannel.send('❎ LFG creation cancelled.');

  const targetChannel = getLfgChannel(guild);
  const listing = await targetChannel.send({ embeds:[ buildListingEmbed(session, authorMember, guild) ] });
  session.listingMessageId = listing.id; session.listingChannelId = targetChannel.id; ACTIVE_POSTS.set(listing.id, session);
  await addManyReactions(listing, [EMOJI_CONFIRM, EMOJI_CANCEL, '▶️']);
  await setupChannel.send(`✅ LFG posted in ${targetChannel}.`);
  if (setupChannel.isThread?.()) { try { await setupChannel.setLocked(true); await setupChannel.setArchived(true); } catch {} }
}

async function promptJoinerSetup(listingMessage, member, session) {
  let dm; try { dm = await member.createDM(); } catch { return false; }
  const regionLines = REGIONS.map((r,i)=>`${NUMS[i]} ${r}`).join('\n');
  let dmMsg = await dm.send({ embeds:[ new EmbedBuilder().setTitle('Join LFG — Choose your region').setColor(0x5865F2).setDescription(`${regionLines}\n\nReact with a number.`) ]});
  await addManyReactions(dmMsg, NUMS.slice(0, REGIONS.length));
  let choice = await awaitReaction(member.id, dmMsg, NUMS.slice(0, REGIONS.length), 120_000);
  if (!choice) { await dm.send('⏱️ Timed out.'); return false; }
  const joinRegion = REGIONS[NUMS.indexOf(choice)];

  const cfg = GUILD_CONFIGS.get(listingMessage.guild.id) || { strictRegion:true };
  if (cfg.strictRegion && session.region && joinRegion !== session.region) {
    await dm.send(`⚠️ This listing is for **${session.region}**. Your selection (**${joinRegion}**) doesn't match.`);
    return false;
  }

  dmMsg = await dm.send({ embeds:[ new EmbedBuilder().setTitle('Join LFG — Choose your role').setColor(0x5865F2).setDescription(`${EMOJI_ROLE_TANK} Tank\n${EMOJI_ROLE_DAMAGE} Damage\n${EMOJI_ROLE_SUPPORT} Support\n${EMOJI_ROLE_FLEX} Flex (any)\n\nReact to choose.`) ]});
  const roleMap = { [EMOJI_ROLE_TANK]:'tank', [EMOJI_ROLE_DAMAGE]:'damage', [EMOJI_ROLE_SUPPORT]:'support', [EMOJI_ROLE_FLEX]:'flex' };
  await addManyReactions(dmMsg, Object.keys(roleMap));
  choice = await awaitReaction(member.id, dmMsg, Object.keys(roleMap), 120_000);
  if (!choice) { await dm.send('⏱️ Timed out.'); return false; }
  const joinRole = roleMap[choice];

  const guild = listingMessage.guild;
  let memberHeroCandidates = [];
  member.roles.cache.forEach(r => { const canon = isHeroRoleObj(r); if (canon) memberHeroCandidates.push(canon); });
  if (joinRole !== 'flex') memberHeroCandidates = memberHeroCandidates.filter(h => HEROES[joinRole].includes(h));
  const displayHeroes = memberHeroCandidates.length ? memberHeroCandidates : heroesForRole(joinRole !== 'flex' ? joinRole : null);

  let page=0; const pageSize=9;
  let heroMsg = await dm.send('Loading hero list…');
  const showHeroPage = async (pg) => {
    const start = pg*pageSize; const items = displayHeroes.slice(start, start+pageSize);
    const lines = items.map((h,i)=>`${NUMS[i]} ${h}`).join('\n') || '*No heroes found; skip if you like.*';
    const e = new EmbedBuilder().setTitle('Choose your hero').setColor(0x5865F2).setDescription(`${lines}\n\nUse ${EMOJI_LEFT} ${EMOJI_RIGHT} to page, ${EMOJI_SKIP} to skip.`);
    await heroMsg.edit({ content:null, embeds:[e] });
  };
  await addManyReactions(heroMsg, [EMOJI_LEFT, ...NUMS, EMOJI_RIGHT, EMOJI_SKIP]);
  await showHeroPage(page);
  let joinHero = null;
  while (true) {
    choice = await awaitReaction(member.id, heroMsg, [EMOJI_LEFT, ...NUMS, EMOJI_RIGHT, EMOJI_SKIP], 120_000);
    if (!choice) { await dm.send('⏱️ Timed out.'); return false; }
    if (choice === EMOJI_LEFT) { page=Math.max(0,page-1); await showHeroPage(page); continue; }
    if (choice === '▶️') { const maxPg=Math.max(0, Math.floor((displayHeroes.length-1)/pageSize)); page=Math.min(maxPg,page+1); await showHeroPage(page); continue; }
    if (choice === EMOJI_SKIP) break;
    if (NUMS.includes(choice)) { const idx=NUMS.indexOf(choice); const start=page*pageSize; const items=displayHeroes.slice(start,start+pageSize); if (idx<items.length) joinHero=items[idx]; break; }
  }

  let joinRank = null;
  if (isCompetitive(session)) {
    const rankLines = RANKS.map((r,i)=>`${NUMS[i]} ${r[0].toUpperCase()+r.slice(1)}`).join('\n');
    dmMsg = await dm.send({ embeds:[ new EmbedBuilder().setTitle('Competitive Join — Pick your rank').setColor(0x5865F2).setDescription(`${rankLines}\n\nReact with a number.`) ]});
    await addManyReactions(dmMsg, NUMS.slice(0, RANKS.length));
    choice = await awaitReaction(member.id, dmMsg, NUMS.slice(0, RANKS.length), 120_000);
    if (!choice) { await dm.send('⏱️ Timed out.'); return false; }
    joinRank = RANKS[NUMS.indexOf(choice)];
    if (session.compRankMin && session.compRankMax) {
      const iMin = RANKS.indexOf(session.compRankMin), iMax = RANKS.indexOf(session.compRankMax), iJ = RANKS.indexOf(joinRank);
      if (!(iMin <= iJ && iJ <= iMax)) { await dm.send(`⚠️ Your rank **${joinRank[0].toUpperCase()+joinRank.slice(1)}** is outside the host's preferred range (**${session.compRankMin}–${session.compRankMax}**).`); return false; }
    }
  }

  const clean = session.joiners.filter(x => x.userId !== member.id);
  clean.push({ userId: member.id, role: joinRole, hero: joinHero, rank: joinRank, region: joinRegion });
  session.joiners = clean;
  await dm.send('✅ You\'re in! Check the LFG post.');
  return true;
}

client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  try { if (reaction.partial) await reaction.fetch(); if (user.partial) await user.fetch(); } catch { return; }
  const message = reaction.message;
  if (!message.guild) return;
  const session = ACTIVE_POSTS.get(message.id);
  if (!session) return;
  const guild = message.guild;
  const author = await guild.members.fetch(session.authorId).catch(()=>null);
  const member = await guild.members.fetch(user.id).catch(()=>null);
  if (!author || !member) return;
  const k = emojiKey(reaction.emoji);

  if (k === EMOJI_CONFIRM) {
    if (session.joiners.some(j => j.userId === member.id)) return;
    if (session.joiners.length >= session.playersNeeded) { try { await member.send('❌ That LFG is already full.'); } catch {} return; }
    const ok = await promptJoinerSetup(message, member, session);
    if (ok) await message.edit({ embeds:[ buildListingEmbed(session, author, guild) ] });
  } else if (k === EMOJI_CANCEL) {
    const before = session.joiners.length;
    session.joiners = session.joiners.filter(j => j.userId !== member.id);
    if (before !== session.joiners.length) await message.edit({ embeds:[ buildListingEmbed(session, author, guild) ] });
  } else if (k === '▶️') {
    try { if (message.channel.isTextBased()) { const thread = await message.startThread({ name:`Team — ${author.displayName}'s LFG` }); await thread.send(`${author} created a team thread. Use this to coordinate.`); } } catch {}
  }
});

// Health server
const app = express();
app.get('/', (_, res) => res.json({ ok: true, service: 'ow2-lfg-bot-node-slash-fixed', status: 'running' }));
app.get('/healthz', (_, res) => res.json({ status: 'ok' }));
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Health server on :${PORT}`));

if (!TOKEN) { console.error('Please set DISCORD_TOKEN in the environment.'); process.exit(1); }
client.login(TOKEN);
