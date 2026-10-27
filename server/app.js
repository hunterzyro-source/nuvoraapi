import cors from 'cors';
import express from 'express';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import { databaseReady, pool } from './database.js';

const app = express();
const server = createServer(app);
const allowedOrigins = (process.env.CORS_ORIGIN || '').split(',')
  .map(value => value.trim().replace(/^['"]|['"]$/g, '').replace(/\/+$/g, ''))
  .filter(Boolean);
const corsOrigin = allowedOrigins.length ? allowedOrigins : true;
const communityPassword = process.env.COMMUNITY_PASSWORD || '';
const redisUrl = process.env.REDIS_URL || process.env.UPSTASH_REDIS_URL || '';
const io = new Server(server, {
  path: '/api/socket.io',
  cors: { origin: corsOrigin },
  transports: ['websocket'],
  pingInterval: 20000,
  pingTimeout: 30000,
});

app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: '100kb' }));

const redisReady = (async () => {
  if (!redisUrl) return false;
  const pub = createClient({ url: redisUrl, socket: { reconnectStrategy: retries => Math.min(retries * 500, 5000) } });
  const sub = pub.duplicate();
  pub.on('error', error => console.error('Redis publisher:', error.message));
  sub.on('error', error => console.error('Redis subscriber:', error.message));
  await Promise.all([pub.connect(), sub.connect()]);
  io.adapter(createAdapter(pub, sub));
  return true;
})();
redisReady.catch(error => console.error('Não foi possível conectar ao Redis compartilhado:', error.message));

app.get('/api/health', async (req, res) => {
  const [database, realtime] = await Promise.allSettled([
    databaseReady.then(() => pool.query('SELECT 1')),
    redisReady,
  ]);
  const healthy = database.status === 'fulfilled' && realtime.status === 'fulfilled' && realtime.value;
  res.status(healthy ? 200 : 503).json({
    ok: healthy,
    database: database.status === 'fulfilled' ? 'postgres' : 'unavailable',
    sharedRealtime: realtime.status === 'fulfilled' ? Boolean(realtime.value) : false,
    mediaRelayConfigured: Boolean(process.env.CLOUDFLARE_TURN_KEY_ID && process.env.CLOUDFLARE_TURN_API_TOKEN),
    ...(realtime.status === 'rejected' ? { realtimeError: 'Redis indisponível; confira REDIS_URL.' } : {}),
    ...(database.status === 'rejected' ? { databaseError: database.reason?.code || 'POSTGRES_CONNECTION_FAILED' } : {}),
  });
});

app.get('/api/session', (req, res) => {
  const authorized = !communityPassword || req.get('authorization') === `Bearer ${communityPassword}`;
  res.json({ required: Boolean(communityPassword), authorized });
});

app.post('/api/session', (req, res) => {
  if (communityPassword && req.body?.password !== communityPassword) {
    return res.status(401).json({ error: 'Código de acesso incorreto.' });
  }
  res.json({ required: Boolean(communityPassword), authorized: true });
});

app.use('/api', async (req, res, next) => {
  if (communityPassword && req.get('authorization') !== `Bearer ${communityPassword}`) {
    return res.status(401).json({ error: 'Acesso restrito. Informe o código da comunidade.' });
  }
  if (req.path === '/rtc/ice-servers') return next();
  try {
    await databaseReady;
    next();
  } catch (error) {
    next(error);
  }
});


app.get('/api/rtc/ice-servers', async (req, res) => {
  const turnKeyId = process.env.CLOUDFLARE_TURN_KEY_ID;
  const turnApiToken = process.env.CLOUDFLARE_TURN_API_TOKEN;
  if (!turnKeyId || !turnApiToken) {
    return res.json({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }], relay: false });
  }
  try {
    const response = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(turnKeyId)}/credentials/generate-ice-servers`,
      { method: 'POST', headers: { Authorization: `Bearer ${turnApiToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl: 43_200 }) },
    );
    if (!response.ok) {
      console.error('Falha ao gerar credenciais TURN:', response.status);
      return res.status(503).json({ error: 'Não foi possível preparar a conexão de mídia.' });
    }
    const { iceServers } = await response.json();
    if (!Array.isArray(iceServers) || !iceServers.some(server => (Array.isArray(server.urls) ? server.urls : [server.urls]).some(url => String(url).startsWith('turn:') || String(url).startsWith('turns:')))) {
      return res.status(502).json({ error: 'O serviço de mídia não retornou um relay válido.' });
    }
    res.json({ iceServers, relay: true });
  } catch (error) {
    console.error('Falha ao consultar TURN:', error.message);
    res.status(503).json({ error: 'Serviço de conexão de mídia indisponível.' });
  }
});

app.get('/api/bootstrap', async (req, res) => {
  const [channels, members] = await Promise.all([
    pool.query('SELECT * FROM channels ORDER BY created_at,id'),
    pool.query('SELECT name,color FROM members ORDER BY name'),
  ]);
  res.json({ channels: channels.rows, members: members.rows, inviteUrl: process.env.PUBLIC_APP_URL || '' });
});

app.post('/api/channels', async (req, res) => {
  const { name, type = 'text', category } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'Dê um nome ao canal.' });
  const normalizedType = type === 'voice' ? 'voice' : 'text';
  const slug = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'canal';
  const channel = {
    id: `${slug}-${randomUUID().slice(0, 8)}`,
    name: name.trim().slice(0, 40),
    type: normalizedType,
    category: category || (normalizedType === 'voice' ? 'CANAIS DE VOZ' : 'CANAIS DE TEXTO'),
  };
  await pool.query('INSERT INTO channels(id,name,type,category) VALUES($1,$2,$3,$4)', [channel.id, channel.name, channel.type, channel.category]);
  io.emit('channels:changed');
  res.status(201).json(channel);
});

app.get('/api/messages/:channel', async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM (SELECT * FROM messages WHERE channel_id=$1 ORDER BY id DESC LIMIT 100) recent ORDER BY id ASC',
    [req.params.channel],
  );
  res.json(result.rows);
});

app.post('/api/messages', async (req, res) => {
  const { channel_id, author, content } = req.body || {};
  if (!channel_id || !author || !content?.trim()) return res.status(400).json({ error: 'Mensagem inválida.' });
  const result = await pool.query(
    'INSERT INTO messages(channel_id,author,content) VALUES($1,$2,$3) RETURNING *',
    [channel_id, author.trim().slice(0, 32), content.trim().slice(0, 4000)],
  );
  io.to(`channel:${channel_id}`).emit('message:new', result.rows[0]);
  res.status(201).json(result.rows[0]);
});

app.post('/api/members', async (req, res) => {
  const { name, color = '#a78bfa' } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'Nome necessário.' });
  await pool.query(
    'INSERT INTO members(name,color) VALUES($1,$2) ON CONFLICT(name) DO UPDATE SET color=EXCLUDED.color',
    [name.trim().slice(0, 32), color],
  );
  io.emit('members:changed');
  res.json({ ok: true });
});

app.delete('/api/members/:name', async (req, res) => {
  await pool.query('DELETE FROM members WHERE name=$1', [req.params.name]);
  io.emit('members:changed');
  res.json({ ok: true });
});

io.use(async (socket, next) => {
  try {
    await redisReady;
    if (communityPassword && socket.handshake.auth?.password !== communityPassword) {
      return next(new Error('Acesso restrito. Informe o código da comunidade.'));
    }
    next();
  } catch {
    next(new Error('O Redis compartilhado está indisponível.'));
  }
});

io.on('connection', socket => {
  socket.on('identify', ({ name, status } = {}) => {
    socket.data.name = String(name || 'Visitante').slice(0, 32);
    socket.data.status = status || 'Disponível';
    broadcastPresence();
  });

  socket.on('channel:join', async id => {
    const oldRooms = [...socket.rooms].filter(room => room.startsWith('channel:'));
    await Promise.all(oldRooms.map(room => socket.leave(room)));
    if (id) {
      await socket.join(`channel:${id}`);
      socket.emit('channel:joined', id);
      const peers = await io.in(`call:${id}`).fetchSockets();
      socket.emit('call:roster', { channel: id, members: peers.map(peer => ({ id: peer.id, channel: id, name: peer.data.name || 'Participante', ...peer.data.media })) });
    }
  });

  socket.on('call:join', async ({ channel, name } = {}, acknowledge) => {
    if (!channel) return acknowledge?.({ error: 'Canal de voz inválido.' });
    const previousChannel = socket.data.callChannel;
    if (previousChannel && previousChannel !== channel) {
      socket.to(`call:${previousChannel}`).emit('call:peer-left', { id: socket.id });
      await socket.leave(`call:${previousChannel}`);
      await broadcastRoster(previousChannel);
    }
    socket.data.name = String(name || 'Visitante').slice(0, 32);
    socket.data.callChannel = channel;
    await socket.join(`call:${channel}`);
    socket.to(`call:${channel}`).emit('call:peer-joined', { id: socket.id, name: socket.data.name });
    const peers = (await io.in(`call:${channel}`).fetchSockets())
      .filter(peer => peer.id !== socket.id)
      .map(peer => ({ id: peer.id, channel, name: peer.data.name || 'Participante', ...peer.data.media }));
    socket.emit('call:peers', peers);
    const roster = [...peers, { id: socket.id, channel, name: socket.data.name, ...socket.data.media }];
    io.emit('call:roster', { channel, members: roster });
    acknowledge?.(roster);
  });

  socket.on('call:media-state', state => {
    const channel = socket.data.callChannel;
    if (!channel) return;
    socket.data.media = { muted: Boolean(state?.muted), camera: Boolean(state?.camera), sharing: Boolean(state?.sharing) };
    broadcastRoster(channel);
  });

  socket.on('call:leave', async channel => {
    const channelId = channel || socket.data.callChannel;
    if (!channelId) return;
    socket.to(`call:${channelId}`).emit('call:peer-left', { id: socket.id });
    await socket.leave(`call:${channelId}`);
    socket.data.callChannel = null;
    await broadcastRoster(channelId);
  });

  for (const event of ['rtc:offer', 'rtc:answer', 'rtc:ice']) {
    socket.on(event, ({ to, ...data } = {}) => { if (to) io.to(to).emit(event, { from: socket.id, ...data }); });
  }

  socket.on('disconnecting', () => {
    if (socket.data.callChannel) {
      socket.to(`call:${socket.data.callChannel}`).emit('call:peer-left', { id: socket.id });
    }
  });
  socket.on('disconnect', () => {
    if (socket.data.callChannel) broadcastRoster(socket.data.callChannel);
    broadcastPresence();
  });
});

async function broadcastRoster(channel) {
  const peers = await io.in(`call:${channel}`).fetchSockets();
  io.emit('call:roster', { channel, members: peers.map(peer => ({ id: peer.id, channel, name: peer.data.name || 'Participante', ...peer.data.media })) });
}

async function broadcastPresence() {
  const sockets = await io.fetchSockets();
  const users = [...new Set(sockets.map(socket => socket.data.status === 'Invisível' ? null : socket.data.name).filter(Boolean))];
  io.emit('presence:update', users);
}

app.use((error, req, res, next) => {
  console.error('Nuvora API:', error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: 'A API encontrou um erro. Tente novamente.' });
});

export { app, io, server };
