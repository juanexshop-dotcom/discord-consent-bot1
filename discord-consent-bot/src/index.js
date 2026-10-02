import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSONFilePreset } from 'lowdb/node';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js';

const required = [
  'DISCORD_BOT_TOKEN',
  'DISCORD_CLIENT_SECRET',
];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing environment variable: ${key}`);
}

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const PORT = Number(process.env.PORT || 3000);

// Railway provides RAILWAY_PUBLIC_DOMAIN automatically after you generate a public domain.
// PUBLIC_BASE_URL remains as an optional fallback for local/other hosting.
const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL?.trim() || (railwayDomain ? `https://${railwayDomain}` : `http://localhost:${PORT}`)).replace(/\/$/, '');
const REDIRECT_URI = `${PUBLIC_BASE_URL}/oauth/callback`;

// Keep OAuth tokens encrypted without asking you to create another environment variable.
// If you reset the Client Secret, existing authorizations must be completed again.
const encryptionKey = crypto.createHash('sha256').update(`discord-consent-bot:${CLIENT_SECRET}`).digest();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '..');
const dbPath = path.join(dataDir, 'data.json');
const db = await JSONFilePreset(dbPath, {
  users: {},
  campaigns: {},
  oauthStates: {},
  guildSettings: {},
});

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, body]).toString('base64');
}

function decrypt(encoded) {
  const raw = Buffer.from(encoded, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const body = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

function oauthUrl(state) {
  const u = new URL('https://discord.com/oauth2/authorize');
  u.searchParams.set('response_type', 'code');
  const clientId = client.application?.id;
  if (!clientId) throw new Error('BOT_NOT_READY');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('scope', 'identify guilds.join');
  u.searchParams.set('state', state);
  u.searchParams.set('redirect_uri', REDIRECT_URI);
  return u.toString();
}

async function exchangeCode(code) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: client.application.id,
    client_secret: CLIENT_SECRET,
  });
  const r = await fetch('https://discord.com/api/v10/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) throw new Error(`OAuth exchange failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function refreshAccessToken(userId) {
  const record = db.data.users[userId];
  if (!record) throw new Error('NOT_VERIFIED');
  if (Date.now() < record.expiresAt - 60_000) return decrypt(record.accessToken);
  if (!record.refreshToken) throw new Error('REAUTHORIZE');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: decrypt(record.refreshToken),
    client_id: client.application.id,
    client_secret: CLIENT_SECRET,
  });
  const r = await fetch('https://discord.com/api/v10/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) throw new Error('REAUTHORIZE');
  const t = await r.json();
  record.accessToken = encrypt(t.access_token);
  record.refreshToken = t.refresh_token ? encrypt(t.refresh_token) : record.refreshToken;
  record.expiresAt = Date.now() + Number(t.expires_in) * 1000;
  await db.write();
  return t.access_token;
}

async function getDiscordUser(accessToken) {
  const r = await fetch('https://discord.com/api/v10/users/@me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) throw new Error(`Could not read Discord user: ${r.status}`);
  return r.json();
}

function parseInviteCode(input) {
  const value = input.trim();
  try {
    const u = new URL(value.startsWith('http') ? value : `https://${value}`);
    const parts = u.pathname.split('/').filter(Boolean);
    if (u.hostname === 'discord.gg') return parts[0];
    if (u.hostname.endsWith('discord.com') && parts[0] === 'invite') return parts[1];
  } catch {}
  if (/^[\w-]+$/.test(value)) return value;
  return null;
}

async function resolveInvite(input) {
  const code = parseInviteCode(input);
  if (!code) throw new Error('Invalid Discord invite URL/code.');
  const r = await fetch(`https://discord.com/api/v10/invites/${encodeURIComponent(code)}?with_counts=true`);
  if (!r.ok) throw new Error('Could not resolve that invite.');
  const invite = await r.json();
  if (!invite.guild?.id) throw new Error('That invite does not point to a server.');
  return { code, invite, guildId: invite.guild.id, guildName: invite.guild.name || 'Servidor' };
}

function campaignCounts(campaign) {
  const values = Object.values(campaign.members || {});
  return {
    joined: values.filter((x) => x.status === 'joined').length,
    pending: values.filter((x) => x.status === 'pending').length,
    failed: values.filter((x) => x.status === 'failed').length,
  };
}

async function addUserToGuild({ userId, guildId, campaignId }) {
  const campaign = db.data.campaigns[campaignId];
  if (!campaign) throw new Error('CAMPAIGN_NOT_FOUND');
  campaign.members ||= {};

  const counts = campaignCounts(campaign);
  if (campaign.limit && counts.joined + counts.pending >= campaign.limit && !campaign.members[userId]) {
    throw new Error('CAMPAIGN_FULL');
  }

  campaign.members[userId] = { status: 'pending', updatedAt: Date.now() };
  await db.write();

  try {
    const accessToken = await refreshAccessToken(userId);
    const r = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bot ${BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ access_token: accessToken }),
    });

    if (!r.ok) {
      const details = await r.text();
      throw new Error(`Discord API ${r.status}: ${details}`);
    }

    let member = null;
    if (r.status !== 204) {
      try { member = await r.json(); } catch {}
    }
    campaign.members[userId] = {
      status: member?.pending ? 'pending' : 'joined',
      updatedAt: Date.now(),
    };
    await db.write();
    return campaign.members[userId].status;
  } catch (err) {
    campaign.members[userId] = { status: 'failed', updatedAt: Date.now(), error: String(err.message || err) };
    await db.write();
    throw err;
  }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Crea los canales de verificación y directorio.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('unirse')
    .setDescription('Publica una campaña de unión con consentimiento por servidor.')
    .addStringOption((o) => o.setName('invite').setDescription('Enlace de invitación del servidor').setRequired(true))
    .addIntegerOption((o) => o.setName('limite').setDescription('Máximo de uniones; vacío = sin límite').setMinValue(1).setMaxValue(1000))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('estado')
    .setDescription('Muestra el estado privado de una campaña.')
    .addStringOption((o) => o.setName('id').setDescription('ID de campaña').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
].map((c) => c.toJSON());

async function registerCommands() {
  const appId = client.application.id;
  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  if (process.env.DEV_GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(appId, process.env.DEV_GUILD_ID), { body: commands });
  } else {
    await rest.put(Routes.applicationCommands(appId), { body: commands });
  }
}

client.once('ready', async () => {
  console.log(`Bot ready as ${client.user.tag}`);
  console.log(`OAuth callback: ${REDIRECT_URI}`);
  try {
    await registerCommands();
    console.log('Slash commands registered.');
  } catch (err) {
    console.error('Could not register slash commands:', err);
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (!interaction.inGuild()) return interaction.reply({ content: 'Usa este comando dentro de un servidor.', ephemeral: true });

      if (interaction.commandName === 'setup') {
        await interaction.deferReply({ ephemeral: true });
        const guild = interaction.guild;
        let verify = guild.channels.cache.find((c) => c.type === ChannelType.GuildText && c.name === 'verificarme');
        let promos = guild.channels.cache.find((c) => c.type === ChannelType.GuildText && c.name === 'servidores');

        const overwrites = [
          { id: guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] },
          { id: guild.members.me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] },
        ];
        if (!verify) verify = await guild.channels.create({ name: 'verificarme', type: ChannelType.GuildText, permissionOverwrites: overwrites });
        if (!promos) promos = await guild.channels.create({ name: 'servidores', type: ChannelType.GuildText, permissionOverwrites: overwrites });

        db.data.guildSettings[guild.id] = { verifyChannelId: verify.id, promoChannelId: promos.id };
        await db.write();

        const verifyEmbed = new EmbedBuilder()
          .setTitle('Verificarme')
          .setDescription(
            'Verifica tu cuenta con OAuth2. Esto permite identificarte y habilita la función de unión. ' +
            '**No te uniremos a ningún servidor solo por verificarte**: cada servidor requerirá que pulses su botón “Unirme”.'
          );
        const verifyRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Verificarme con Discord').setURL(`${PUBLIC_BASE_URL}/oauth/start`)
        );
        await verify.send({ embeds: [verifyEmbed], components: [verifyRow] });
        await interaction.editReply(`Listo: ${verify} y ${promos}.`);
      }

      if (interaction.commandName === 'unirse') {
        await interaction.deferReply({ ephemeral: true });
        const inviteInput = interaction.options.getString('invite', true);
        const limit = interaction.options.getInteger('limite') || null;
        const { code, invite, guildId, guildName } = await resolveInvite(inviteInput);

        if (!client.guilds.cache.has(guildId)) {
          return interaction.editReply('El bot debe estar dentro del servidor de destino antes de poder usar `guilds.join`.');
        }

        const settings = db.data.guildSettings[interaction.guildId];
        if (!settings?.promoChannelId) return interaction.editReply('Primero ejecuta `/setup`.');
        const channel = await interaction.guild.channels.fetch(settings.promoChannelId);
        if (!channel?.isTextBased()) return interaction.editReply('No encuentro el canal de servidores. Ejecuta `/setup` otra vez.');

        const id = crypto.randomBytes(5).toString('hex');
        db.data.campaigns[id] = {
          id,
          sourceGuildId: interaction.guildId,
          targetGuildId: guildId,
          targetGuildName: guildName,
          inviteCode: code,
          inviteUrl: `https://discord.gg/${code}`,
          limit,
          createdBy: interaction.user.id,
          createdAt: Date.now(),
          active: true,
          members: {},
        };
        await db.write();

        const embed = new EmbedBuilder()
          .setTitle(`Unirme a ${guildName}`)
          .setDescription(
            `Pulsa **Unirme** si quieres entrar en este servidor. Tu clic es el consentimiento para **este servidor concreto**.\n` +
            (limit ? `Plazas de esta campaña: **${limit}**.` : 'Sin límite configurado para esta campaña.')
          );
        if (invite.guild?.icon) {
          embed.setThumbnail(`https://cdn.discordapp.com/icons/${guildId}/${invite.guild.icon}.png`);
        }
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`join:${id}`).setStyle(ButtonStyle.Primary).setLabel('Unirme')
        );
        const msg = await channel.send({ embeds: [embed], components: [row] });
        db.data.campaigns[id].messageId = msg.id;
        await db.write();
        await interaction.editReply(`Campaña creada. ID: \`${id}\`. Usa \`/estado id:${id}\` para ver unidos, pendientes y fallidos.`);
      }

      if (interaction.commandName === 'estado') {
        const id = interaction.options.getString('id', true);
        const campaign = db.data.campaigns[id];
        if (!campaign || campaign.sourceGuildId !== interaction.guildId) {
          return interaction.reply({ content: 'No existe esa campaña en este servidor.', ephemeral: true });
        }
        const c = campaignCounts(campaign);
        return interaction.reply({
          ephemeral: true,
          content:
            `**${campaign.targetGuildName}** — campaña \`${id}\`\n` +
            `✅ Unidos: **${c.joined}**\n⏳ Pendientes: **${c.pending}**\n❌ Fallidos: **${c.failed}**\n` +
            `Límite: **${campaign.limit ?? 'sin límite'}**`,
        });
      }
    }

    if (interaction.isButton() && interaction.customId.startsWith('join:')) {
      const id = interaction.customId.slice(5);
      const campaign = db.data.campaigns[id];
      if (!campaign?.active) return interaction.reply({ content: 'Esta campaña ya no está activa.', ephemeral: true });
      if (campaign.members?.[interaction.user.id]?.status === 'joined') {
        return interaction.reply({ content: 'Ya constas como unido a este servidor.', ephemeral: true });
      }

      const c = campaignCounts(campaign);
      if (campaign.limit && c.joined + c.pending >= campaign.limit && !campaign.members?.[interaction.user.id]) {
        return interaction.reply({ content: 'Esta campaña ya alcanzó su límite.', ephemeral: true });
      }

      if (!db.data.users[interaction.user.id]) {
        const url = `${PUBLIC_BASE_URL}/oauth/start?campaign=${encodeURIComponent(id)}`;
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Autorizar y unirme').setURL(url)
        );
        return interaction.reply({
          ephemeral: true,
          content: `Para unirte a **${campaign.targetGuildName}**, autoriza OAuth2 y volveremos a intentar esta unión concreta.`,
          components: [row],
        });
      }

      await interaction.deferReply({ ephemeral: true });
      try {
        const status = await addUserToGuild({ userId: interaction.user.id, guildId: campaign.targetGuildId, campaignId: id });
        await interaction.editReply(status === 'pending'
          ? 'La unión se inició, pero el servidor todavía tiene un paso de verificación pendiente.'
          : `Listo: te has unido a **${campaign.targetGuildName}**.`);
      } catch (err) {
        if (String(err.message).includes('REAUTHORIZE')) {
          const url = `${PUBLIC_BASE_URL}/oauth/start?campaign=${encodeURIComponent(id)}`;
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Reautorizar y unirme').setURL(url)
          );
          return interaction.editReply({ content: 'Tu autorización caducó. Reautoriza para continuar.', components: [row] });
        }
        if (String(err.message).includes('CAMPAIGN_FULL')) return interaction.editReply('La campaña acaba de alcanzar su límite.');
        console.error(err);
        return interaction.editReply('No pude completar la unión. Revisa que el bot siga en el servidor de destino y vuelve a intentarlo.');
      }
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable()) {
      const msg = 'Ha ocurrido un error. Revisa la consola del bot.';
      if (interaction.deferred || interaction.replied) interaction.editReply(msg).catch(() => {});
      else interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
    }
  }
});

const app = express();

app.get('/oauth/start', async (req, res) => {
  const state = crypto.randomBytes(24).toString('hex');
  const campaignId = typeof req.query.campaign === 'string' ? req.query.campaign : null;
  if (campaignId && !db.data.campaigns[campaignId]) return res.status(404).send('Campaña no encontrada.');
  db.data.oauthStates[state] = { createdAt: Date.now(), campaignId };
  await db.write();
  res.redirect(oauthUrl(state));
});

app.get('/oauth/callback', async (req, res) => {
  const code = typeof req.query.code === 'string' ? req.query.code : null;
  const state = typeof req.query.state === 'string' ? req.query.state : null;
  if (!code || !state) return res.status(400).send('Faltan code/state.');

  const saved = db.data.oauthStates[state];
  delete db.data.oauthStates[state];
  await db.write();
  if (!saved || Date.now() - saved.createdAt > 10 * 60_000) return res.status(400).send('OAuth state inválido o caducado.');

  try {
    const token = await exchangeCode(code);
    const me = await getDiscordUser(token.access_token);
    db.data.users[me.id] = {
      accessToken: encrypt(token.access_token),
      refreshToken: token.refresh_token ? encrypt(token.refresh_token) : null,
      expiresAt: Date.now() + Number(token.expires_in) * 1000,
      authorizedAt: Date.now(),
    };
    await db.write();

    if (saved.campaignId) {
      const campaign = db.data.campaigns[saved.campaignId];
      try {
        const status = await addUserToGuild({ userId: me.id, guildId: campaign.targetGuildId, campaignId: saved.campaignId });
        return res.send(`<h2>Listo</h2><p>${status === 'pending' ? 'La unión está pendiente de la verificación del servidor.' : `Te has unido a ${escapeHtml(campaign.targetGuildName)}.`}</p><p>Ya puedes cerrar esta pestaña.</p>`);
      } catch (err) {
        console.error(err);
        return res.status(400).send('<h2>Verificado, pero no pude completar la unión.</h2><p>Vuelve a Discord e inténtalo otra vez.</p>');
      }
    }

    res.send('<h2>Verificación completada</h2><p>No te has unido a ningún servidor. Vuelve a Discord y elige el servidor al que quieras unirte.</p>');
  } catch (err) {
    console.error(err);
    res.status(500).send('No se pudo completar OAuth2.');
  }
});

function escapeHtml(value = '') {
  return value.replace(/[&<>'"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}

app.get('/', (_req, res) => {
  res.send('<h2>Discord Consent Bot</h2><p>Bot online.</p>');
});

app.get('/health', (_req, res) => res.status(200).send('ok'));

app.listen(PORT, '0.0.0.0', () => console.log(`OAuth web server listening on port ${PORT}`));
await client.login(BOT_TOKEN);
