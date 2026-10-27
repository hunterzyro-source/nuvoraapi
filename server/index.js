import express from 'express';
import cors from 'cors';
import http from 'node:http';
import { Server } from 'socket.io';
import Database from 'better-sqlite3';
import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const usePostgres = Boolean(process.env.DATABASE_URL);
const sqlite = usePostgres ? null : new Database(process.env.DATABASE_PATH || path.join(here, 'community.sqlite'));
const postgres = usePostgres ? new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  max: 10,
}) : null;

if (sqlite) {
  sqlite.pragma('journal_mode = WAL');
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'text',
      category TEXT NOT NULL DEFAULT 'Geral', created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id TEXT NOT NULL,
      author TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS members (
      name TEXT PRIMARY KEY, color TEXT NOT NULL, joined_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function postgresSql(query) {
  let index = 0;
  return query.replace(/\?/g, () => `$${++index}`);
}

async function all(query, params = []) {
  if (postgres) return (await postgres.query(postgresSql(query), params)).rows;
  return sqlite.prepare(query).all(...params);
}

async function one(query, params = []) {
  if (postgres) return (await postgres.query(postgresSql(query), params)).rows[0];
  return sqlite.prepare(query).get(...params);
}

async function run(query, params = []) {
  if (postgres) return postgres.query(postgresSql(query), params);
  return sqlite.prepare(query).run(...params);
}

async function initializeDatabase() {
  if (postgres) {
    await postgres.query(`
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'text',
        category TEXT NOT NULL DEFAULT 'Geral', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS messages (
        id BIGSERIAL PRIMARY KEY, channel_id TEXT NOT NULL,
        author TEXT NOT NULL, content TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS members (
        name TEXT PRIMARY KEY, color TEXT NOT NULL, joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  }

  const { n } = await one('SELECT count(*) AS n FROM channels');
  if (Number(n) !== 0) return;
  const defaults = [
    ['geral', 'geral', 'text', 'CANAIS DE TEXTO'],
    ['apresentacoes', 'apresentações', 'text', 'CANAIS DE TEXTO'],
    ['trabalho', 'trabalho', 'text', 'CANAIS DE TEXTO'],
    ['salinha', 'Salinha', 'voice', 'CANAIS DE VOZ'],
    ['reuniao', 'Reunião', 'voice', 'CANAIS DE VOZ'],
  ];
  for (const channel of defaults) {
    await run('INSERT INTO channels(id,name,type,category) VALUES(?,?,?,?)', channel);
  }
}

const app = express();
const server = http.createServer(app);
const allowedOrigins = (process.env.CORS_ORIGIN || '').split(',').map(value => value.trim()).filter(Boolean);
const corsOrigin = allowedOrigins.length ? allowedOrigins : true;
const communityPassword = process.env.COMMUNITY_PASSWORD || '';
const io = new Server(server, { cors: { origin: corsOrigin } });
app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: '100kb' }));

app.get('/health', (req, res) => res.json({ ok: true, storage: usePostgres ? 'postgres' : 'sqlite' }));
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
app.use('/api', (req, res, next) => {
  if (communityPassword && req.get('authorization') !== `Bearer ${communityPassword}`) {
    return res.status(401).json({ error: 'Acesso restrito. Informe o código da comunidade.' });
  }
  next();
});

app.get('/api/bootstrap', async (req, res) => {
  res.json({
    channels: await all('SELECT * FROM channels ORDER BY created_at,id'),
    members: await all('SELECT name,color FROM members'),
    inviteUrl: process.env.PUBLIC_APP_URL || '',
  });
});

app.post('/api/channels', async (req, res) => {
  const { name, type = 'text', category } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'Dê um nome ao canal.' });
  const slug = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'canal';
  const channel = {
    id: `${slug}-${randomUUID().slice(0, 8)}`,
    name: name.trim().slice(0, 40),
    type: type === 'voice' ? 'voice' : 'text',
    category: category || (type === 'voice' ? 'CANAIS DE VOZ' : 'CANAIS DE TEXTO'),
  };
  await run('INSERT INTO channels(id,name,type,category) VALUES(?,?,?,?)', [channel.id, channel.name, channel.type, channel.category]);
  io.emit('channels:changed');
  res.status(201).json(channel);
});

app.get('/api/messages/:channel', async (req, res) => {
  const messages = await all('SELECT * FROM messages WHERE channel_id=? ORDER BY id DESC LIMIT 100', [req.params.channel]);
  res.json(messages.reverse());
});

app.post('/api/messages', async (req, res) => {
  const { channel_id, author, content } = req.body || {};
  if (!channel_id || !author || !content?.trim()) return res.status(400).json({ error: 'Mensagem inválida.' });
  const values = [channel_id, author.trim().slice(0, 32), content.trim().slice(0, 4000)];
  let message;
  if (postgres) {
    message = (await postgres.query('INSERT INTO messages(channel_id,author,content) VALUES($1,$2,$3) RETURNING *', values)).rows[0];
  } else {
    const result = await run('INSERT INTO messages(channel_id,author,content) VALUES(?,?,?)', values);
    message = await one('SELECT * FROM messages WHERE id=?', [result.lastInsertRowid]);
  }
  io.to(`channel:${channel_id}`).emit('message:new', message);
  res.status(201).json(message);
});

app.post('/api/members', async (req, res) => {
  const { name, color = '#a78bfa' } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'Nome necessário.' });
  await run('INSERT INTO members(name,color) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET color=excluded.color', [name.trim().slice(0, 32), color]);
  io.emit('members:changed');
  res.json({ ok: true });
});

app.delete('/api/members/:name', async (req, res) => {
  await run('DELETE FROM members WHERE name=?', [req.params.name]);
  io.emit('members:changed');
  res.json({ ok: true });
});

io.use((socket, next) => {
  if (communityPassword && socket.handshake.auth?.password !== communityPassword) {
    return next(new Error('Acesso restrito. Informe o código da comunidade.'));
  }
  next();
});

io.on('connection', socket => {
  socket.on('identify', ({ name, status } = {}) => {
    socket.data.name = String(name || 'Visitante').slice(0, 32);
    socket.data.status = status || 'Disponível';
    io.emit('presence:update', presence());
  });
  socket.on('channel:join', id => {
    for (const room of socket.rooms) if (room.startsWith('channel:')) socket.leave(room);
    if (id) socket.join(`channel:${id}`);
  });
  socket.on('call:join', ({ channel, name } = {}) => {
    if (!channel) return;
    socket.data.name = name || 'Visitante';
    socket.join(`call:${channel}`);
    socket.to(`call:${channel}`).emit('call:peer-joined', { id: socket.id, name: socket.data.name });
    socket.emit('call:peers', Array.from(io.sockets.adapter.rooms.get(`call:${channel}`) || [])
      .filter(id => id !== socket.id)
      .map(id => ({ id, name: io.sockets.sockets.get(id)?.data.name || 'Participante' })));
    io.to(`call:${channel}`).emit('call:roster', roster(channel));
  });
  socket.on('call:leave', channel => {
    if (!channel) return;
    socket.to(`call:${channel}`).emit('call:peer-left', { id: socket.id });
    socket.leave(`call:${channel}`);
    io.to(`call:${channel}`).emit('call:roster', roster(channel));
  });
  for (const event of ['rtc:offer', 'rtc:answer', 'rtc:ice']) {
    socket.on(event, ({ to, ...data } = {}) => { if (to) io.to(to).emit(event, { from: socket.id, ...data }); });
  }
  socket.on('disconnect', () => io.emit('presence:update', presence()));
});

function roster(channel) {
  return Array.from(io.sockets.adapter.rooms.get(`call:${channel}`) || [])
    .map(id => ({ id, name: io.sockets.sockets.get(id)?.data.name || 'Participante' }));
}

function presence() {
  return [...new Set([...io.sockets.sockets.values()]
    .map(socket => socket.data.status === 'Invisível' ? null : socket.data.name).filter(Boolean))];
}

const port = Number(process.env.PORT || 3001);
await initializeDatabase();
server.listen(port, '0.0.0.0', () => console.log(`Nuvora API disponível na porta ${port} (${usePostgres ? 'PostgreSQL' : 'SQLite'})`));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    io.close();
    if (postgres) await postgres.end();
    if (sqlite) sqlite.close();
    process.exit(0);
  });
}
