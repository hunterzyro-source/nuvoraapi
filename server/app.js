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
const allowedOrigins = (process.env.CORS_ORIGIN || '').split(',').map(value => value.trim()).filter(Boolean);
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
  try {
    await databaseReady;
    await pool.query('SELECT 1');
    res.json({ ok: true, database: 'postgres', sharedRealtime: await redisReady });
  } catch (error) {
    res.status(503).json({ ok: false, error: 'Banco ou Redis indisponível.' });
  }
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
  try {
    await databaseReady;
    next();
  } catch (error) {
    next(error);
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

  socket.on('channel:join', id => {
    for (const room of socket.rooms) if (room.startsWith('channel:')) socket.leave(room);
    if (id) socket.join(`channel:${id}`);
  });

  socket.on('call:join', async ({ channel, name } = {}) => {
    if (!channel) return;
    socket.data.name = name || 'Visitante';
    socket.data.callChannel = channel;
    await socket.join(`call:${channel}`);
    socket.to(`call:${channel}`).emit('call:peer-joined', { id: socket.id, name: socket.data.name });
    const peers = (await io.in(`call:${channel}`).fetchSockets())
      .filter(peer => peer.id !== socket.id)
      .map(peer => ({ id: peer.id, name: peer.data.name || 'Participante' }));
    socket.emit('call:peers', peers);
    await broadcastRoster(channel);
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
  io.to(`call:${channel}`).emit('call:roster', peers.map(peer => ({ id: peer.id, name: peer.data.name || 'Participante' })));
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
