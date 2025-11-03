/* eslint-disable no-console */
const {
  Client, GatewayIntentBits, Partials,
  EmbedBuilder, PermissionsBitField, SlashCommandBuilder, ChannelType,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder
} = require('discord.js');
const express = require('express');
require('dotenv').config();

const TOKEN = process.env.DISCORD_TOKEN;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember, Partials.User]
});

const RANKS = ['bronze','silver','gold','platinum','diamond','master','grandmaster','champion'];
const REGIONS = ['NA','EU','APAC','LATAM','OCE','ME','AFR'];
const HEROES = {
  tank: ['d.va','doomfist','junker queen','orisa','ramattra','reinhardt','roadhog','sigma','winston','wrecking ball','zarya','mauga'],
  damage: ['ashe','bastion','cassidy','echo','genji','hanzo','junkrat','mei','pharah','reaper','sojourn','soldier: 76','sombra','symmetra','torbjorn','tracer','widowmaker','venture'],
  support: ['ana','baptiste','brigitte','illari','kiriko','lifeweaver','lucio','mercy','moira','zenyatta']
};
const ROLE_LABEL = { tank:'Tank', damage:'Damage', support:'Support', flex:'Flex' };
const MODE_LABEL = { comp_role:'Competitive (Role Queue)', comp_open:'Competitive (Open Queue)', qp_role:'Quick Play (Role Queue)', qp_open:'Quick Play (Open Queue)', arcade:'Arcade', custom:'Custom Game' };
const isCompetitive = (m)=>m==='comp_role'||m==='comp_open';

const GCFG = new Map(); // guildId -> { channelId, strictRegion, allowThreads }
const ACTIVE = new Map(); // messageId -> session

const makeSession = (guildId, authorId)=>({ guildId, authorId, mode:null, role:null, hero:null, compRankMin:null, compRankMax:null, region:null, micRequired:false, playersNeeded:4, joiners:[], messageId:null, channelId:null });

const summaryEmbed = (s, author)=>{
  const e = new EmbedBuilder().setTitle(`LFG • ${MODE_LABEL[s.mode]||'Unknown'}`).setColor(0x5865F2).setAuthor({ name: author.displayName, iconURL: author.displayAvatarURL() });
  const setup = [`**Role**: ${ROLE_LABEL[s.role]||'?'}`, `**Hero**: ${s.hero||'any'}`, `**Region**: ${s.region||'?'}`, `**Mic**: ${s.micRequired?'required':'optional'}`, `**Players needed**: ${s.playersNeeded}`].join('\n');
  e.addFields({ name:'Setup', value: setup });
  if (isCompetitive(s.mode)) e.addFields({ name:'Competitive Preferences', value:`**Rank range**: ${s.compRankMin||'?'} — ${s.compRankMax||'?'}` });
  return e;
};
const listingEmbed = (s, author, guild)=>{
  const e = summaryEmbed(s, author);
  const lines = s.joiners.map(j=>{
    const m = guild.members.cache.get(j.userId);
    const name = m? m.toString(): `<@${j.userId}>`;
    const bits = []; if (j.role) bits.push(ROLE_LABEL[j.role]); if (j.hero) bits.push(j.hero); if (isCompetitive(s.mode)&&j.rank) bits.push(j.rank); if (j.region) bits.push(j.region);
    return `- ${name} (${bits.join(', ')})`;
  });
  e.addFields({ name:'Joiners', value: lines.length? lines.join('\n') : '*No joiners yet.*' });
  if (s.joiners.length >= s.playersNeeded) e.setColor(0x57F287).setDescription('**Status: FULL**');
  else e.setDescription('Use the buttons below to **Join** or **Leave**. The host can open a team thread when ready.');
  return e;
};

const slash = [
  new SlashCommandBuilder().setName('lfg').setDescription('Start the OW2 LFG wizard (ephemeral).'),
  new SlashCommandBuilder().setName('lfg_set_channel').setDescription('Owner only: set the LFG channel').addChannelOption(o=>o.setName('channel').setDescription('Text channel').addChannelTypes(ChannelType.GuildText).setRequired(true)),
  new SlashCommandBuilder().setName('lfg_info').setDescription('Show LFG configuration'),
  new SlashCommandBuilder().setName('lfg_set_options').setDescription('Owner only: set options').addBooleanOption(o=>o.setName('region_strict').setDescription('Require joiners to match region (default on)')).addBooleanOption(o=>o.setName('allow_threads').setDescription('Create threads (default on)'))
].map(c=>c.toJSON());

async function registerCommands(guild){ try{ await guild.commands.set(slash); console.log(`[slash] registered for ${guild.name}`);}catch(e){ console.error(e);} }

client.once('ready', async ()=>{
  console.log(`Logged in as ${client.user.tag}`);
  for (const [,g] of client.guilds.cache){ await registerCommands(g); if(!GCFG.has(g.id)) GCFG.set(g.id,{ channelId:null, strictRegion:true, allowThreads:true }); }
});
client.on('guildCreate', async g=>{ await registerCommands(g); GCFG.set(g.id,{ channelId:null, strictRegion:true, allowThreads:true }); });

client.on('interactionCreate', async (ix)=>{
  if (ix.isChatInputCommand()){
    const cfg = GCFG.get(ix.guild.id) || { channelId:null, strictRegion:true, allowThreads:true };
    const ownerId = ix.guild.ownerId;
    if (ix.commandName==='lfg_set_channel'){
      if (ix.user.id!==ownerId) return void ix.reply({ content:'Only the server owner can do this.', ephemeral:true });
      const ch = ix.options.getChannel('channel', true);
      if (ch.type!==ChannelType.GuildText) return void ix.reply({ content:'Pick a text channel.', ephemeral:true });
      GCFG.set(ix.guild.id, { ...cfg, channelId: ch.id });
      return void ix.reply({ content:`✅ LFG channel set to ${ch}.`, ephemeral:true });
    }
    if (ix.commandName==='lfg_info'){
      const ch = cfg.channelId? `<#${cfg.channelId}>` : '*(not set)*';
      const text = `**Channel**: ${ch}\n**Region strict**: ${cfg.strictRegion?'on':'off'}\n**Allow threads**: ${cfg.allowThreads?'on':'off'}`;
      return void ix.reply({ embeds:[ new EmbedBuilder().setTitle('LFG Config').setColor(0x5865F2).setDescription(text) ], ephemeral:true });
    }
    if (ix.commandName==='lfg_set_options'){
      if (ix.user.id!==ownerId) return void ix.reply({ content:'Only the server owner can do this.', ephemeral:true });
      const regionStrict = ix.options.getBoolean('region_strict');
      const allowThreads = ix.options.getBoolean('allow_threads');
      const next = { ...cfg }; if (regionStrict!==null) next.strictRegion=regionStrict; if (allowThreads!==null) next.allowThreads=allowThreads; GCFG.set(ix.guild.id,next);
      return void ix.reply({ content:`✅ Options updated: region_strict=${next.strictRegion?'on':'off'}, allow_threads=${next.allowThreads?'on':'off'}`, ephemeral:true });
    }
    if (ix.commandName==='lfg'){
      if (!cfg.channelId) return void ix.reply({ content:'Set an LFG channel first with /lfg_set_channel', ephemeral:true });
      await startHostWizard(ix, cfg);
    }
  } else if (ix.isButton()){
    await handleButton(ix);
  }
});

async function startHostWizard(ix, cfg){
  const guild = ix.guild; const me = ix.member; let s = makeSession(guild.id, me.id);

  // Step 1 - Mode
  const row1a = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('mode:comp_role').setLabel('Comp (Role)').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('mode:comp_open').setLabel('Comp (Open)').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('mode:qp_role').setLabel('QP (Role)').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('mode:qp_open').setLabel('QP (Open)').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('mode:arcade').setLabel('Arcade').setStyle(ButtonStyle.Secondary)
  );
  const row1b = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('mode:custom').setLabel('Custom Game').setStyle(ButtonStyle.Secondary));
  await ix.reply({ embeds:[ new EmbedBuilder().setTitle('LFG — Step 1').setDescription('Choose a **game mode**').setColor(0x5865F2) ], components:[row1a,row1b], ephemeral:true });
  const msg1 = await ix.fetchReply();
  const pick1 = await msg1.awaitMessageComponent({ componentType:2, time:120_000 }).catch(()=>null);
  if (!pick1) return void ix.followUp({ content:'Timed out. Run /lfg again.', ephemeral:true });
  s.mode = pick1.customId.split(':')[1]; await pick1.update({ components:[] });

  // Step 2 - Role
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('role:tank').setLabel('Tank').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('role:damage').setLabel('Damage').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('role:support').setLabel('Support').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('role:flex').setLabel('Flex').setStyle(ButtonStyle.Secondary)
  );
  const msg2 = await ix.followUp({ embeds:[ new EmbedBuilder().setTitle('LFG — Step 2').setDescription('Pick your **role**').setColor(0x5865F2) ], components:[row2], ephemeral:true });
  const pick2 = await msg2.awaitMessageComponent({ componentType:2, time:120_000 }).catch(()=>null);
  if (!pick2) return void ix.followUp({ content:'Timed out.', ephemeral:true });
  s.role = pick2.customId.split(':')[1]; await pick2.update({ components:[] });

  // Step 3 - Hero
  const heroList = s.role!=='flex' ? HEROES[s.role] : Array.from(new Set([...HEROES.tank,...HEROES.damage,...HEROES.support])).sort();
  const options = heroList.slice(0,25).map(h=>({label:h,value:h}));
  const row3 = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('hero').setPlaceholder('Choose a hero (or skip)').addOptions(options));
  const msg3 = await ix.followUp({ embeds:[ new EmbedBuilder().setTitle('LFG — Step 3').setDescription('Pick your **hero** (or skip)').setColor(0x5865F2) ], components:[row3], ephemeral:true });
  const pick3 = await msg3.awaitMessageComponent({ componentType:3, time:120_000 }).catch(()=>null);
  if (pick3){ s.hero = pick3.values[0]; await pick3.update({ components:[] }); } else s.hero = null;

  // Step 4 - Ranks if competitive
  if (isCompetitive(s.mode)){
    const row4a = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('rmin').setPlaceholder('Minimum rank').addOptions(RANKS.map(r=>({label:r[0].toUpperCase()+r.slice(1), value:r}))));
    const m4a = await ix.followUp({ embeds:[ new EmbedBuilder().setTitle('LFG — Step 4').setDescription('Pick **minimum** rank').setColor(0x5865F2) ], components:[row4a], ephemeral:true });
    const i4a = await m4a.awaitMessageComponent({ componentType:3, time:120_000 }).catch(()=>null);
    if (!i4a) return void ix.followUp({ content:'Timed out.', ephemeral:true });
    s.compRankMin = i4a.values[0]; await i4a.update({ components:[] });

    const row4b = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('rmax').setPlaceholder('Maximum rank').addOptions(RANKS.map(r=>({label:r[0].toUpperCase()+r.slice(1), value:r}))));
    const m4b = await ix.followUp({ embeds:[ new EmbedBuilder().setTitle('LFG — Step 4').setDescription('Pick **maximum** rank').setColor(0x5865F2) ], components:[row4b], ephemeral:true });
    const i4b = await m4b.awaitMessageComponent({ componentType:3, time:120_000 }).catch(()=>null);
    if (!i4b) return void ix.followUp({ content:'Timed out.', ephemeral:true });
    s.compRankMax = i4b.values[0];
    if (RANKS.indexOf(s.compRankMax) < RANKS.indexOf(s.compRankMin)) [s.compRankMin, s.compRankMax] = [s.compRankMax, s.compRankMin];
    await i4b.update({ components:[] });
  }

  // Step 5 - Region
  const row5 = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('region').setPlaceholder('Pick region').addOptions(REGIONS.map(r=>({label:r,value:r}))));
  const msg5 = await ix.followUp({ embeds:[ new EmbedBuilder().setTitle('LFG — Step 5').setDescription('Pick **region**').setColor(0x5865F2) ], components:[row5], ephemeral:true });
  const i5 = await msg5.awaitMessageComponent({ componentType:3, time:120_000 }).catch(()=>null);
  if (!i5) return void ix.followUp({ content:'Timed out.', ephemeral:true });
  s.region = i5.values[0]; await i5.update({ components:[] });

  // Step 6 - Mic & party size
  const row6 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('mic:on').setLabel('Mic required').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('mic:off').setLabel('Mic optional').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ps:1').setLabel('+1').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ps:2').setLabel('+2').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ps:3').setLabel('+3').setStyle(ButtonStyle.Secondary)
  );
  const msg6 = await ix.followUp({ embeds:[ new EmbedBuilder().setTitle('LFG — Step 6').setDescription('Toggle mic and choose **players needed** (+1..+4)').setColor(0x5865F2) ], components:[row6], ephemeral:true });
  const i6 = await msg6.awaitMessageComponent({ time:120_000 }).catch(()=>null);
  if (!i6) return void ix.followUp({ content:'Timed out.', ephemeral:true });
  const [k,v] = i6.customId.split(':');
  if (k==='mic') s.micRequired = (v==='on');
  if (k==='ps') s.playersNeeded = Math.min(4, Math.max(1, parseInt(v)));
  await i6.update({ components:[] });

  // Confirm & post
  const actions = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('lfg:post').setLabel('Post LFG').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId('lfg:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary));
  const conf = await ix.followUp({ embeds:[ summaryEmbed(s, me).setFooter({ text:'Post this in the LFG channel?' }) ], components:[actions], ephemeral:true });
  const ok = await conf.awaitMessageComponent({ time:120_000 }).catch(()=>null);
  if (!ok || ok.customId==='lfg:cancel') return void ix.followUp({ content:'Cancelled.', ephemeral:true });
  await ok.update({ components:[] });

  const channel = guild.channels.cache.get(GCFG.get(guild.id).channelId);
  const rowPublic = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('join').setLabel('✅ Join').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('leave').setLabel('❌ Leave').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('thread').setLabel('▶️ Team Thread').setStyle(ButtonStyle.Secondary)
  );
  const listing = await channel.send({ embeds:[ listingEmbed(s, me, guild) ], components:[rowPublic] });
  s.messageId = listing.id; s.channelId = channel.id; ACTIVE.set(listing.id, s);
  await ix.followUp({ content:`✅ LFG posted in ${channel}`, ephemeral:true });
}

async function handleButton(ix){
  // Ignore buttons that belong to the ephemeral wizard; those are handled
  // by the message-component collectors inside startHostWizard.
  const id = ix.customId || '';
  if (id.startsWith('mode:') || id.startsWith('role:') || id.startsWith('mic:') || id.startsWith('ps:')
      || id.startsWith('lfg:') || id.startsWith('hero') || id.startsWith('rmin') || id.startsWith('rmax')
      || id.startsWith('joinrole:') || id.startsWith('join:') ) {
    return; // let the local collector handle it
  }
const s = ACTIVE.get(ix.message.id);
  if (!s) return void ix.reply({ content:'This LFG is no longer active.', ephemeral:true });
  const guild = ix.guild; const member = ix.member;
  if (ix.customId==='join'){
    const cfg = GCFG.get(guild.id) || { strictRegion:true };
    const rowRegion = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('join:region').setPlaceholder('Pick region').addOptions(REGIONS.map(r=>({label:r,value:r}))));
    await ix.reply({ embeds:[ new EmbedBuilder().setTitle('Join — Step 1').setDescription('Pick **region**').setColor(0x5865F2) ], components:[rowRegion], ephemeral:true });
    const msg = await ix.fetchReply(); const s1 = await msg.awaitMessageComponent({ componentType:3, time:120_000 }).catch(()=>null);
    if (!s1) return;
    const region = s1.values[0]; await s1.update({ components:[] });
    if (cfg.strictRegion && s.region && region!==s.region) return void ix.followUp({ content:`⚠️ This LFG is for **${s.region}**. Your region **${region}** doesn’t match.`, ephemeral:true });

    const rowRole = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('joinrole:tank').setLabel('Tank').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('joinrole:damage').setLabel('Damage').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('joinrole:support').setLabel('Support').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('joinrole:flex').setLabel('Flex').setStyle(ButtonStyle.Secondary)
    );
    const m2 = await ix.followUp({ embeds:[ new EmbedBuilder().setTitle('Join — Step 2').setDescription('Pick **role**').setColor(0x5865F2) ], components:[rowRole], ephemeral:true });
    const s2 = await m2.awaitMessageComponent({ componentType:2, time:120_000 }).catch(()=>null); if (!s2) return;
    const role = s2.customId.split(':')[1]; await s2.update({ components:[] });

    const heroList = role!=='flex' ? HEROES[role] : Array.from(new Set([...HEROES.tank,...HEROES.damage,...HEROES.support])).sort();
    const options = heroList.slice(0,25).map(h=>({label:h,value:h}));
    const rowHero = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('join:hero').setPlaceholder('Pick hero (or skip)').addOptions(options));
    const m3 = await ix.followUp({ embeds:[ new EmbedBuilder().setTitle('Join — Step 3').setDescription('Pick **hero** (or skip)').setColor(0x5865F2) ], components:[rowHero], ephemeral:true });
    const s3 = await m3.awaitMessageComponent({ componentType:3, time:120_000 }).catch(()=>null);
    const hero = s3? s3.values[0] : null; if (s3) await s3.update({ components:[] });

    let rank = null;
    if (isCompetitive(s.mode)){
      const rowRank = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('join:rank').setPlaceholder('Pick rank').addOptions(RANKS.map(r=>({label:r[0].toUpperCase()+r.slice(1), value:r}))));
      const m4 = await ix.followUp({ embeds:[ new EmbedBuilder().setTitle('Join — Step 4').setDescription('Pick **rank**').setColor(0x5865F2) ], components:[rowRank], ephemeral:true });
      const s4 = await m4.awaitMessageComponent({ componentType:3, time:120_000 }).catch(()=>null); if (!s4) return; rank = s4.values[0]; await s4.update({ components:[] });
      if (s.compRankMin && s.compRankMax){ const iMin=RANKS.indexOf(s.compRankMin), iMax=RANKS.indexOf(s.compRankMax), iJ=RANKS.indexOf(rank); if (!(iMin<=iJ&&iJ<=iMax)) return void ix.followUp({ content:`⚠️ Rank **${rank}** outside host’s preferred range (**${s.compRankMin}–${s.compRankMax}**).`, ephemeral:true }); }
    }

    s.joiners = s.joiners.filter(j=>j.userId!==member.id);
    if (s.joiners.length >= s.playersNeeded) return void ix.followUp({ content:'This LFG is already full.', ephemeral:true });
    s.joiners.push({ userId: member.id, role, hero, rank, region });
    const author = await guild.members.fetch(s.authorId).catch(()=>member);
    await ix.message.edit({ embeds:[ listingEmbed(s, author, guild) ] });
    return void ix.followUp({ content:'✅ You joined!', ephemeral:true });
  }

  if (ix.customId==='leave'){
    const before = s.joiners.length; s.joiners = s.joiners.filter(j=>j.userId!==member.id);
    if (s.joiners.length===before) return void ix.reply({ content:'You were not in this group.', ephemeral:true });
    const author = await guild.members.fetch(s.authorId).catch(()=>member);
    await ix.message.edit({ embeds:[ listingEmbed(s, author, guild) ] });
    return void ix.reply({ content:'✅ You left the group.', ephemeral:true });
  }

  if (ix.customId==='thread'){
    try { const thread = await ix.message.startThread({ name:`Team — ${member.displayName || 'LFG'}`, autoArchiveDuration:60 }); await thread.send('Team thread created.'); return void ix.reply({ content:'Thread created.', ephemeral:true }); }
    catch { return void ix.reply({ content:'Could not create a thread here.', ephemeral:true }); }
  }
}

// Health server
const app = express();
app.get('/healthz', (_,res)=>res.json({ status:'ok' }));
const PORT = process.env.PORT || 8080;
app.listen(PORT, ()=>console.log('Health server on :'+PORT));

if (!TOKEN){ console.error('Set DISCORD_TOKEN'); process.exit(1); }
client.login(TOKEN);
