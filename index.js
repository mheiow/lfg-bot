/* eslint-disable no-console */
const {
  Client, GatewayIntentBits, Partials,
  EmbedBuilder, SlashCommandBuilder, ChannelType,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  PermissionsBitField
} = require('discord.js');
const express = require('express');
require('dotenv').config();
const TOKEN = process.env.DISCORD_TOKEN;

// -------- Client --------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember, Partials.User]
});

// -------- Data --------
const RANKS = ['bronze','silver','gold','platinum','diamond','master','grandmaster','champion'];
const REGIONS = ['NA','EU','APAC','LATAM','OCE','ME','AFR'];
const PLATFORMS = ['PC','Console','Any'];
const HEROES = {
  tank: ['d.va','doomfist','junker queen','orisa','ramattra','reinhardt','roadhog','sigma','winston','wrecking ball','zarya','mauga'],
  damage: ['ashe','bastion','cassidy','echo','genji','hanzo','junkrat','mei','pharah','reaper','sojourn','soldier: 76','sombra','symmetra','torbjorn','tracer','widowmaker','venture'],
  support: ['ana','baptiste','brigitte','illari','kiriko','lifeweaver','lucio','mercy','moira','zenyatta']
};
const ROLE_EMOJI = { tank:'🛡️', damage:'⚔️', support:'✨', flex:'🔁' };
const REGION_EMOJI = { NA:'🌎', EU:'🇪🇺', APAC:'🌏', LATAM:'🌎', OCE:'🌊', ME:'🕌', AFR:'🌍' };
const PLATFORM_EMOJI = { PC:'💻', Console:'🎮', Any:'✨' };
const MODE_LABEL = { comp_role:'Competitive (Role Queue)', comp_open:'Competitive (Open Queue)', qp_role:'Quick Play (Role Queue)', qp_open:'Quick Play (Open Queue)', arcade:'Arcade', custom:'Custom Game' };
const isCompetitive = m => m==='comp_role'||m==='comp_open';
const isRoleQueue = m => m==='comp_role'||m==='qp_role';

// In-memory config/state
const CFG = new Map(); // guildId -> { channelId, logChannelId }
const ACTIVE = new Map(); // messageId -> session
const TIMERS = new Map(); // messageId -> timeout

// -------- Utils --------
const now = () => Date.now();
function makeSession(guildId, authorId){
  return {
    sessionId: Math.random().toString(36).slice(2,10),
    guildId, authorId,
    mode:null, role:null, hero:null,
    compRankMin:null, compRankMax:null,
    region:null, regionStrict:true,
    platform:'Any',
    micRequired:false,
    playersNeeded:4,
    joiners:[], // { userId, role, hero, rank, region, platform }
    messageId:null, channelId:null,
    createdAt: now(),
    expireAt: null, // ms timestamp
    posted:false
  };
}

function roleLabel(r){ return r ? `${ROLE_EMOJI[r]||''} ${r[0].toUpperCase()+r.slice(1)}` : '—'; }
function modeLabel(m){ return MODE_LABEL[m] || 'Unknown'; }
function regionLabel(r){ return r ? `${REGION_EMOJI[r]||'🌐'} ${r}` : '—'; }
function platformLabel(p){ return p ? `${PLATFORM_EMOJI[p]||''} ${p}` : '—'; }
function rankLabel(r){ return r ? r[0].toUpperCase()+r.slice(1) : '—'; }

function colorForRank(r){
  const map = { bronze:0x8a5a44, silver:0xc0c0c0, gold:0xd4af37, platinum:0x4fb1c9, diamond:0x5ad1ff, master:0xaa66ff, grandmaster:0xff5555, champion:0xff7f27 };
  return map[r] || 0x5865F2;
}

function summaryEmbed(sess, author, title='LFG — Review & Confirm'){
  const e = new EmbedBuilder().setTitle(title).setColor(isCompetitive(sess.mode) ? colorForRank(sess.compRankMax||sess.compRankMin||'') : 0x2b2d31);
  if (author) e.setAuthor({ name: author.displayName, iconURL: author.displayAvatarURL() });
  const lines = [
    `**Mode:** ${modeLabel(sess.mode)}`,
    isRoleQueue(sess.mode) ? `**Role:** ${roleLabel(sess.role)}` : `**Role:** *(Open Queue)*`,
    `**Hero:** ${sess.hero || 'any'}`,
    isCompetitive(sess.mode) ? `**Rank range:** ${rankLabel(sess.compRankMin)} — ${rankLabel(sess.compRankMax)}` : null,
    `**Region:** ${regionLabel(sess.region)} ${sess.regionStrict? '• strict' : '• cross-region ok'}`,
    `**Platform:** ${platformLabel(sess.platform)}`,
    `**Mic:** ${sess.micRequired ? 'required' : 'optional'}`,
    `**Players needed:** ${sess.playersNeeded}`
  ].filter(Boolean);
  e.setDescription(lines.join('\n'));
  if (sess.expireAt) {
    const mins = Math.round((sess.expireAt - now())/60000);
    e.setFooter({ text: `Auto-expires in ~${Math.max(mins,1)} min` });
  }
  return e;
}

function listingEmbed(sess, author, guild){
  const e = new EmbedBuilder().setTitle(`LFG • ${modeLabel(sess.mode)}`)
    .setColor(isCompetitive(sess.mode) ? colorForRank(sess.compRankMax||sess.compRankMin||'') : 0x5865F2);
  if (author) e.setAuthor({ name: author.displayName, iconURL: author.displayAvatarURL() });
  const setup = [
    isRoleQueue(sess.mode) ? `**Role**: ${roleLabel(sess.role)}` : `**Role**: *(Open Queue)*`,
    `**Hero**: ${sess.hero || 'any'}`,
    isCompetitive(sess.mode) ? `**Rank**: ${rankLabel(sess.compRankMin)} — ${rankLabel(sess.compRankMax)}` : null,
    `**Region**: ${regionLabel(sess.region)} ${sess.regionStrict? '• strict' : '• cross-region ok'}`,
    `**Platform**: ${platformLabel(sess.platform)}`,
    `**Mic**: ${sess.micRequired ? 'required' : 'optional'}`,
    `**Players needed**: ${sess.playersNeeded}`
  ].filter(Boolean).join('\n');
  e.addFields({ name:'Setup', value: setup });

  const lines = sess.joiners.map(j=>{
    const m = guild.members.cache.get(j.userId);
    const name = m ? m.toString() : `<@${j.userId}>`;
    const bits = [];
    if (j.role) bits.push(roleLabel(j.role));
    if (j.hero) bits.push(j.hero);
    if (isCompetitive(sess.mode) && j.rank) bits.push(rankLabel(j.rank));
    if (j.region) bits.push(regionLabel(j.region));
    if (j.platform) bits.push(platformLabel(j.platform));
    return `- ${name} (${bits.join(', ')})`;
  });
  e.addFields({ name:'Joiners', value: lines.length? lines.join('\n') : '*No joiners yet.*' });

  if (sess.joiners.length >= sess.playersNeeded) {
    e.setColor(0x57F287).setDescription('**Status: FULL** — team thread will be created automatically.');
  } else {
    e.setDescription('Press **Join** or **Leave** below.');
  }
  if (sess.expireAt) e.setFooter({ text:`Expires ${new Date(sess.expireAt).toLocaleString()}` });
  return e;
}

function hasPerms(guild, channel){
  const me = guild.members.me;
  if (!me) return false;
  const need = [
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.SendMessages,
    PermissionsBitField.Flags.ReadMessageHistory
  ];
  return channel?.permissionsFor(me)?.has(need) ?? false;
}

async function tryLog(guild, text){
  const conf = CFG.get(guild.id); if (!conf?.logChannelId) return;
  const ch = guild.channels.cache.get(conf.logChannelId);
  if (ch && hasPerms(guild, ch)) { try { await ch.send(text); } catch {} }
}

function clearTimer(messageId){
  const t = TIMERS.get(messageId); if (t) { clearTimeout(t); TIMERS.delete(messageId); }
}

async function expireListing(message){
  const sess = ACTIVE.get(message.id);
  if (!sess) return;
  sess.expired = true;
  clearTimer(message.id);
  ACTIVE.delete(message.id);
  try {
    const author = await message.guild.members.fetch(sess.authorId).catch(()=>null);
    const e = listingEmbed(sess, author, message.guild).setColor(0x747f8d).setDescription('**Status: EXPIRED**');
    await message.edit({ embeds:[e], components:[] });
  } catch {}
  await tryLog(message.guild, `🕒 LFG expired in ${message.channel}: <https://discord.com/channels/${message.guild.id}/${message.channel.id}/${message.id}>`);
}

// -------- Commands --------
const slash = [
  new SlashCommandBuilder().setName('lfg')
    .setDescription('Start the OW2 LFG wizard (ephemeral).'),
  new SlashCommandBuilder().setName('lfg_set_channel')
    .setDescription('Owner only: set the LFG channel')
    .addChannelOption(o=>o.setName('channel').setDescription('Text channel').addChannelTypes(ChannelType.GuildText).setRequired(true)),
  new SlashCommandBuilder().setName('lfg_set_log_channel')
    .setDescription('Owner only: set the LFG log channel')
    .addChannelOption(o=>o.setName('channel').setDescription('Text channel').addChannelTypes(ChannelType.GuildText).setRequired(true)),
  new SlashCommandBuilder().setName('lfg_info').setDescription('Show LFG configuration')
].map(c=>c.toJSON());

async function registerCommands(guild){
  try { await guild.commands.set(slash); console.log(`[slash] registered for ${guild.name}`); }
  catch(e){ console.error('slash register failed', e); }
}

client.once('ready', async ()=>{
  console.log(`Logged in as ${client.user.tag}`);
  for (const [,g] of client.guilds.cache) {
    await registerCommands(g);
    if (!CFG.has(g.id)) CFG.set(g.id, { channelId:null, logChannelId:null });
  }
});
client.on('guildCreate', async g=>{
  await registerCommands(g); CFG.set(g.id, { channelId:null, logChannelId:null });
});

client.on('interactionCreate', async (ix)=>{
  if (ix.isChatInputCommand()) {
    const conf = CFG.get(ix.guild.id) || { channelId:null, logChannelId:null };
    const ownerId = ix.guild.ownerId;
    if (ix.commandName === 'lfg_set_channel'){
      if (ix.user.id !== ownerId) return void ix.reply({ content:'Only the server owner can do this.', ephemeral:true });
      const ch = ix.options.getChannel('channel', true);
      if (ch.type !== ChannelType.GuildText) return void ix.reply({ content:'Pick a text channel.', ephemeral:true });
      CFG.set(ix.guild.id, { ...conf, channelId: ch.id });
      return void ix.reply({ content:`✅ LFG channel set to ${ch}.`, ephemeral:true });
    }
    if (ix.commandName === 'lfg_set_log_channel'){
      if (ix.user.id !== ownerId) return void ix.reply({ content:'Only the server owner can do this.', ephemeral:true });
      const ch = ix.options.getChannel('channel', true);
      if (ch.type !== ChannelType.GuildText) return void ix.reply({ content:'Pick a text channel.', ephemeral:true });
      CFG.set(ix.guild.id, { ...conf, logChannelId: ch.id });
      return void ix.reply({ content:`📝 Log channel set to ${ch}.`, ephemeral:true });
    }
    if (ix.commandName === 'lfg_info'){
      const ch = conf.channelId ? `<#${conf.channelId}>` : '*(not set)*';
      const log = conf.logChannelId ? `<#${conf.logChannelId}>` : '*(not set)*';
      const txt = `**LFG channel**: ${ch}\n**Log channel**: ${log}`;
      return void ix.reply({ embeds:[ new EmbedBuilder().setTitle('LFG Config').setDescription(txt).setColor(0x5865F2) ], ephemeral:true });
    }
    if (ix.commandName === 'lfg'){
      if (!conf.channelId) return void ix.reply({ content:'Set an LFG channel first with **/lfg_set_channel**.', ephemeral:true });
      const channel = ix.guild.channels.cache.get(conf.channelId);
      if (!hasPerms(ix.guild, channel)) return void ix.reply({ content:`I’m missing permissions to send messages in ${channel}.`, ephemeral:true });
      await startWizard(ix, conf);
    }
  } else if (ix.isButton()) {
    await handleButton(ix);
  } else if (ix.isStringSelectMenu()) {
    // handled within collectors
  }
});

// -------- Wizard --------
async function startWizard(ix, conf){
  const guild = ix.guild, me = ix.member;
  let s = makeSession(guild.id, me.id);

  // STEP 1: Mode
  const row1a = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`mode:${s.sessionId}:comp_role`).setLabel('Comp (Role)').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`mode:${s.sessionId}:comp_open`).setLabel('Comp (Open)').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`mode:${s.sessionId}:qp_role`).setLabel('QP (Role)').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`mode:${s.sessionId}:qp_open`).setLabel('QP (Open)').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`mode:${s.sessionId}:arcade`).setLabel('Arcade').setStyle(ButtonStyle.Secondary)
  );
  const row1b = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`mode:${s.sessionId}:custom`).setLabel('Custom Game').setStyle(ButtonStyle.Secondary));
  await ix.reply({ embeds:[ new EmbedBuilder().setTitle('LFG — Step 1').setDescription('Choose a **game mode**').setColor(0x5865F2) ], components:[row1a,row1b], ephemeral:true });
  const msg1 = await ix.fetchReply();
  const pick1 = await msg1.awaitMessageComponent({ componentType:2, time:120000 }).catch(()=>null);
  if (!pick1) return void ix.followUp({ content:'Timed out. Run /lfg again.', ephemeral:true });
  s.mode = pick1.customId.split(':')[2]; await pick1.update({ components:[] });

  // STEP 2: Role (skip for Open Queue)
  if (isRoleQueue(s.mode)) {
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`role:${s.sessionId}:tank`).setLabel('Tank').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`role:${s.sessionId}:damage`).setLabel('Damage').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`role:${s.sessionId}:support`).setLabel('Support').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`role:${s.sessionId}:flex`).setLabel('Flex').setStyle(ButtonStyle.Secondary)
    );
    const msg2 = await ix.followUp({ embeds:[ new EmbedBuilder().setTitle('LFG — Step 2').setDescription('Pick your **role**').setColor(0x5865F2) ], components:[row2], ephemeral:true });
    const pick2 = await msg2.awaitMessageComponent({ componentType:2, time:120000 }).catch(()=>null);
    if (!pick2) return void ix.followUp({ content:'Timed out.', ephemeral:true });
    s.role = pick2.customId.split(':')[2]; await pick2.update({ components:[] });
  }

  // STEP 3: Hero
  const heroes = isRoleQueue(s.mode) && s.role !== 'flex' ? HEROES[s.role] : Array.from(new Set([...HEROES.tank,...HEROES.damage,...HEROES.support])).sort();
  const options = heroes.slice(0,25).map(h=>({ label:h, value:h }));
  const row3 = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`hero:${s.sessionId}`).setPlaceholder('Choose a hero (or skip)').addOptions(options));
  const msg3 = await ix.followUp({ embeds:[ new EmbedBuilder().setTitle('LFG — Step 3').setDescription('Pick your **hero** (or skip)').setColor(0x5865F2) ], components:[row3], ephemeral:true });
  const pick3 = await msg3.awaitMessageComponent({ componentType:3, time:120000 }).catch(()=>null);
  if (pick3){ s.hero = pick3.values[0]; await pick3.update({ components:[] }); } else s.hero = null;

  // STEP 4: Rank range if competitive
  if (isCompetitive(s.mode)) {
    const opts = RANKS.map(r=>({ label:r[0].toUpperCase()+r.slice(1), value:r }));
    const row4a = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`rmin:${s.sessionId}`).setPlaceholder('Minimum rank').addOptions(opts));
    const m4a = await ix.followUp({ embeds:[ new EmbedBuilder().setTitle('LFG — Step 4').setDescription('Pick **minimum rank**').setColor(0x5865F2) ], components:[row4a], ephemeral:true });
    const i4a = await m4a.awaitMessageComponent({ componentType:3, time:120000 }).catch(()=>null);
    if (!i4a) return void ix.followUp({ content:'Timed out.', ephemeral:true });
    s.compRankMin = i4a.values[0]; await i4a.update({ components:[] });

    const row4b = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`rmax:${s.sessionId}`).setPlaceholder('Maximum rank').addOptions(opts));
    const m4b = await ix.followUp({ embeds:[ new EmbedBuilder().setTitle('LFG — Step 4').setDescription('Pick **maximum rank**').setColor(0x5865F2) ], components:[row4b], ephemeral:true });
    const i4b = await m4b.awaitMessageComponent({ componentType:3, time:120000 }).catch(()=>null);
    if (!i4b) return void ix.followUp({ content:'Timed out.', ephemeral:true });
    s.compRankMax = i4b.values[0];
    if (RANKS.indexOf(s.compRankMax) < RANKS.indexOf(s.compRankMin)) [s.compRankMin, s.compRankMax] = [s.compRankMax, s.compRankMin];
    await i4b.update({ components:[] });
  }

  // STEP 5: Region (with cross-region toggle)
  const row5a = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`region:${s.sessionId}`).setPlaceholder('Pick region').addOptions(REGIONS.map(r=>({label:r, value:r}))));
  const m5a = await ix.followUp({ embeds:[ new EmbedBuilder().setTitle('LFG — Step 5A').setDescription('Pick **region**').setColor(0x5865F2) ], components:[row5a], ephemeral:true });
  const i5a = await m5a.awaitMessageComponent({ componentType:3, time:120000 }).catch(()=>null);
  if (!i5a) return void ix.followUp({ content:'Timed out.', ephemeral:true });
  s.region = i5a.values[0]; await i5a.update({ components:[] });

  const row5b = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`cross:${s.sessionId}:on`).setLabel('Allow cross-region').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`cross:${s.sessionId}:off`).setLabel('Strict region').setStyle(ButtonStyle.Primary)
  );
  const m5b = await ix.followUp({ embeds:[ new EmbedBuilder().setTitle('LFG — Step 5B').setDescription('Choose **cross-region** behavior.').setColor(0x5865F2) ], components:[row5b], ephemeral:true });
  const i5b = await m5b.awaitMessageComponent({ componentType:2, time:120000 }).catch(()=>null);
  if (!i5b) return void ix.followUp({ content:'Timed out.', ephemeral:true });
  s.regionStrict = i5b.customId.endsWith(':off') ? true : false;
  await i5b.update({ components:[] });

  // STEP 6A: Mic
  const row6a = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`mic:${s.sessionId}:on`).setLabel('Mic required').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`mic:${s.sessionId}:off`).setLabel('Mic optional').setStyle(ButtonStyle.Secondary)
  );
  const msg6a = await ix.followUp({ embeds:[ new EmbedBuilder().setTitle('LFG — Step 6A').setDescription('Set **voice chat** requirement.').setColor(0x5865F2) ], components:[row6a], ephemeral:true });
  const i6a = await msg6a.awaitMessageComponent({ componentType:2, time:120000 }).catch(()=>null);
  if (!i6a) return void ix.followUp({ content:'Timed out.', ephemeral:true });
  s.micRequired = i6a.customId.endsWith(':on'); await i6a.update({ components:[] });

  // STEP 6B: Players needed
  const row6b = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ps:${s.sessionId}:1`).setLabel('+1').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`ps:${s.sessionId}:2`).setLabel('+2').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`ps:${s.sessionId}:3`).setLabel('+3').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`ps:${s.sessionId}:4`).setLabel('+4').setStyle(ButtonStyle.Secondary)
  );
  const msg6b = await ix.followUp({ embeds:[ new EmbedBuilder().setTitle('LFG — Step 6B').setDescription('Select **players needed** to complete your team.').setColor(0x5865F2) ], components:[row6b], ephemeral:true });
  const i6b = await msg6b.awaitMessageComponent({ componentType:2, time:120000 }).catch(()=>null);
  if (!i6b) return void ix.followUp({ content:'Timed out.', ephemeral:true });
  s.playersNeeded = Math.min(4, Math.max(1, parseInt(i6b.customId.split(':')[2]))); await i6b.update({ components:[] });

  // STEP 7: Platform
  const row7 = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`platform:${s.sessionId}`).setPlaceholder('Pick platform').addOptions(PLATFORMS.map(p=>({label:p, value:p}))));
  const m7 = await ix.followUp({ embeds:[ new EmbedBuilder().setTitle('LFG — Step 7').setDescription('Pick **platform**').setColor(0x5865F2) ], components:[row7], ephemeral:true });
  const i7 = await m7.awaitMessageComponent({ componentType:3, time:120000 }).catch(()=>null);
  if (!i7) return void ix.followUp({ content:'Timed out.', ephemeral:true });
  s.platform = i7.values[0]; await i7.update({ components:[] });

  // STEP 8: Expiration
  const row8 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`exp:${s.sessionId}:60`).setLabel('Expire in 1h').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`exp:${s.sessionId}:120`).setLabel('Expire in 2h').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`exp:${s.sessionId}:180`).setLabel('Expire in 3h').setStyle(ButtonStyle.Secondary)
  );
  const m8 = await ix.followUp({ embeds:[ new EmbedBuilder().setTitle('LFG — Step 8').setDescription('Choose **auto-expire** time.').setColor(0x5865F2) ], components:[row8], ephemeral:true });
  const i8 = await m8.awaitMessageComponent({ componentType:2, time:120000 }).catch(()=>null);
  if (!i8) return void ix.followUp({ content:'Timed out.', ephemeral:true });
  const minutes = parseInt(i8.customId.split(':')[2]); s.expireAt = now() + minutes*60000; await i8.update({ components:[] });

  // FINAL SUMMARY
  const actions = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`confirm:${s.sessionId}:post`).setLabel('✅ Post').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`confirm:${s.sessionId}:edit`).setLabel('✏️ Edit').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`confirm:${s.sessionId}:cancel`).setLabel('❌ Cancel').setStyle(ButtonStyle.Danger)
  );
  const summary = await ix.followUp({ embeds:[ summaryEmbed(s, me) ], components:[actions], ephemeral:true });
  const done = await summary.awaitMessageComponent({ componentType:2, time:120000 }).catch(()=>null);
  if (!done || done.customId.endsWith(':cancel')) return void ix.followUp({ content:'Cancelled.', ephemeral:true });
  if (done.customId.endsWith(':edit')) return void ix.followUp({ content:'Editing not implemented in this build. Rerun /lfg.', ephemeral:true });
  await done.update({ components:[] });

  // POST
  const postChannel = guild.channels.cache.get(conf.channelId);
  const rowPublic = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`join:${s.sessionId}`).setLabel('✅ Join').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`leave:${s.sessionId}`).setLabel('❌ Leave').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`remove:${s.sessionId}`).setLabel('🧹 Remove Player').setStyle(ButtonStyle.Secondary)
  );
  const author = me;
  const mentionRole = guild.roles.cache.find(r => r.name.toLowerCase() === 'lfg');
  const content = mentionRole ? `${mentionRole}` : null;
  const listing = await postChannel.send({ content, embeds:[ listingEmbed(s, author, guild) ], components:[rowPublic] });
  s.messageId = listing.id; s.channelId = postChannel.id; s.posted = true; ACTIVE.set(listing.id, s);
  try { await summary.edit({ components: [] }); } catch {}

  // Schedule expiration
  if (s.expireAt) {
    const delay = Math.max(1000, s.expireAt - now());
    const timer = setTimeout(async ()=>{
      try { const ch = guild.channels.cache.get(s.channelId); if (!ch) return;
        const msg = await ch.messages.fetch(s.messageId).catch(()=>null); if (msg) await expireListing(msg);
      } catch {}
    }, delay);
    TIMERS.set(listing.id, timer);
  }

  await tryLog(guild, `🟢 LFG posted in ${postChannel}: <https://discord.com/channels/${guild.id}/${postChannel.id}/${listing.id}>`);
  await ix.followUp({ content:`✅ LFG posted in ${postChannel}`, ephemeral:true });
}

// -------- Buttons (public) --------
async function handleButton(ix){
  const id = ix.customId || '';
  // Ignore wizard-scoped or mismatched sessionIds
  const parts = id.split(':');
  const base = parts[0];
  if (!['join','leave','remove'].includes(base)) return;
  const sessionId = parts[1];

  const sess = ACTIVE.get(ix.message.id);
  if (!sess || sess.sessionId !== sessionId) {
    return void ix.reply({ content:'This LFG is no longer active.', ephemeral:true });
  }
  if (sess.expireAt && now() > sess.expireAt) {
    // expire immediately
    const msg = ix.message;
    await expireListing(msg);
    return void ix.reply({ content:'This LFG has expired.', ephemeral:true });
  }

  const guild = ix.guild;
  const author = await guild.members.fetch(sess.authorId).catch(()=>null);
  const member = ix.member;

  if (base === 'join') {
    // Joiner ephemeral wizard
    // Region
    const rowRegion = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`joinregion:${sessionId}`).setPlaceholder('Pick region').addOptions(REGIONS.map(r=>({label:r,value:r}))));
    await ix.reply({ embeds:[ new EmbedBuilder().setTitle('Join — Step 1').setDescription('Pick **region**').setColor(0x5865F2) ], components:[rowRegion], ephemeral:true });
    const msg = await ix.fetchReply();
    const s1 = await msg.awaitMessageComponent({ componentType:3, time:120000 }).catch(()=>null);
    if (!s1) return;
    const region = s1.values[0]; await s1.update({ components:[] });
    if (sess.regionStrict && sess.region && region !== sess.region) {
      return void ix.followUp({ content:`⚠️ This LFG is **${sess.region} only**. Your region **${region}** doesn't match.`, ephemeral:true });
    }

    // Platform
    const rowPlat = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`joinplat:${sessionId}`).setPlaceholder('Pick platform').addOptions(PLATFORMS.map(p=>({label:p,value:p}))));
    const mP = await ix.followUp({ embeds:[ new EmbedBuilder().setTitle('Join — Step 2').setDescription('Pick **platform**').setColor(0x5865F2) ], components:[rowPlat], ephemeral:true });
    const iP = await mP.awaitMessageComponent({ componentType:3, time:120000 }).catch(()=>null);
    if (!iP) return;
    const platform = iP.values[0]; await iP.update({ components:[] });

    // Role (enforced only for role queue)
    let role = null;
    if (isRoleQueue(sess.mode)) {
      const rowRole = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`joinrole:${sessionId}:tank`).setLabel('Tank').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`joinrole:${sessionId}:damage`).setLabel('Damage').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`joinrole:${sessionId}:support`).setLabel('Support').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`joinrole:${sessionId}:flex`).setLabel('Flex').setStyle(ButtonStyle.Secondary)
      );
      const mR = await ix.followUp({ embeds:[ new EmbedBuilder().setTitle('Join — Step 3').setDescription('Pick **role**').setColor(0x5865F2) ], components:[rowRole], ephemeral:true });
      const iR = await mR.awaitMessageComponent({ componentType:2, time:120000 }).catch(()=>null);
      if (!iR) return;
      role = iR.customId.split(':')[2]; await iR.update({ components:[] });
    }

    // Hero (optional)
    const heroList = role && role!=='flex' ? HEROES[role] : Array.from(new Set([...HEROES.tank,...HEROES.damage,...HEROES.support])).sort();
    const options = heroList.slice(0,25).map(h=>({label:h,value:h}));
    const rowHero = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`joinhero:${sessionId}`).setPlaceholder('Pick **hero** (optional)').addOptions(options));
    const mH = await ix.followUp({ embeds:[ new EmbedBuilder().setTitle('Join — Step 4').setDescription('Pick **hero** (or skip)').setColor(0x5865F2) ], components:[rowHero], ephemeral:true });
    const iH = await mH.awaitMessageComponent({ componentType:3, time:120000 }).catch(()=>null);
    const hero = iH ? iH.values[0] : null; if (iH) await iH.update({ components:[] });

    // Rank if comp
    let rank = null;
    if (isCompetitive(sess.mode)) {
      const rowRank = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`joinrank:${sessionId}`).setPlaceholder('Pick your rank').addOptions(RANKS.map(r=>({label:r[0].toUpperCase()+r.slice(1), value:r}))));
      const mK = await ix.followUp({ embeds:[ new EmbedBuilder().setTitle('Join — Step 5').setDescription('Pick **rank**').setColor(0x5865F2) ], components:[rowRank], ephemeral:true });
      const iK = await mK.awaitMessageComponent({ componentType:3, time:120000 }).catch(()=>null);
      if (!iK) return;
      rank = iK.values[0]; await iK.update({ components:[] });
      if (sess.compRankMin && sess.compRankMax) {
        const iMin = RANKS.indexOf(sess.compRankMin), iMax = RANKS.indexOf(sess.compRankMax), iJ = RANKS.indexOf(rank);
        if (!(iMin <= iJ && iJ <= iMax)) {
          return void ix.followUp({ content:`⚠️ Rank **${rank}** outside host’s preferred range (**${sess.compRankMin}–${sess.compRankMax}**).`, ephemeral:true });
        }
      }
    }

    // Save joiner
    if (sess.joiners.find(j=>j.userId===member.id)) {
      return void ix.followUp({ content:'You have already joined this group.', ephemeral:true });
    }
    if (sess.joiners.length >= sess.playersNeeded) {
      return void ix.followUp({ content:'This LFG is already full.', ephemeral:true });
    }
    sess.joiners.push({ userId: member.id, role, hero, rank, region, platform });

    // Update embed
    await ix.message.edit({ embeds:[ listingEmbed(sess, author, guild) ] });

    // Auto-create team thread when FULL
    if (sess.joiners.length >= sess.playersNeeded) {
      try {
        const thread = await ix.message.startThread({ name: `Team — ${author?.displayName || 'LFG'}`, autoArchiveDuration: 60 });
        await thread.send(`Team is full! ${[author, ...sess.joiners.map(j=>`<@${j.userId}>`)].join(' ')} — coordinate here.`);
      } catch {}
    }

    await tryLog(guild, `➕ ${member} joined LFG <https://discord.com/channels/${guild.id}/${ix.channel.id}/${ix.message.id}>`);
    return void ix.followUp({ content:'✅ You joined!', ephemeral:true });
  }

  if (base === 'leave') {
    const before = sess.joiners.length;
    sess.joiners = sess.joiners.filter(j=>j.userId !== member.id);
    if (sess.joiners.length === before) return void ix.reply({ content:'You were not in this group.', ephemeral:true });
    await ix.message.edit({ embeds:[ listingEmbed(sess, author, guild) ] });
    await tryLog(guild, `➖ ${member} left LFG <https://discord.com/channels/${guild.id}/${ix.channel.id}/${ix.message.id}>`);
    return void ix.reply({ content:'✅ You left the group.', ephemeral:true });
  }

  if (base === 'remove') {
    if (member.id !== sess.authorId) return void ix.reply({ content:'Only the host can remove players.', ephemeral:true });
    if (sess.joiners.length === 0) return void ix.reply({ content:'No players to remove.', ephemeral:true });
    const opts = sess.joiners.map(j=>({ label: ix.guild.members.cache.get(j.userId)?.displayName || j.userId, value: j.userId }));
    const row = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`kick:${sess.sessionId}`).setPlaceholder('Select a player to remove').addOptions(opts));
    await ix.reply({ embeds:[ new EmbedBuilder().setTitle('Remove Player').setDescription('Pick a player to remove from this LFG.').setColor(0xffa500) ], components:[row], ephemeral:true });
    const msg = await ix.fetchReply();
    const choice = await msg.awaitMessageComponent({ componentType:3, time:120000 }).catch(()=>null);
    if (!choice) return;
    const uid = choice.values[0]; await choice.update({ components:[] });
    sess.joiners = sess.joiners.filter(j=>j.userId !== uid);
    await ix.message.edit({ embeds:[ listingEmbed(sess, author, guild) ] });
    await tryLog(guild, `🧹 Host removed <@${uid}> from LFG <https://discord.com/channels/${guild.id}/${ix.channel.id}/${ix.message.id}>`);
    return void ix.followUp({ content:`Removed <@${uid}>.`, ephemeral:true });
  }
}

// -------- Health server --------
const app = express();
app.get('/', (_,res)=>res.json({ ok:true, service:'ow2-lfg-bot-pro', status:'running' }));
app.get('/healthz', (_,res)=>res.json({ status:'ok' }));
const PORT = process.env.PORT || 8080;
app.listen(PORT, ()=>console.log('Health server on :'+PORT));

if (!TOKEN){ console.error('Please set DISCORD_TOKEN'); process.exit(1); }
client.login(TOKEN);
