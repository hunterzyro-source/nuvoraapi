import pg from 'pg';

if (!process.env.DATABASE_URL) {
  throw new Error('Configure DATABASE_URL com a conexão do PostgreSQL antes de iniciar a API.');
}

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

export async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'text',
      category TEXT NOT NULL DEFAULT 'Geral',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      channel_id TEXT NOT NULL,
      author TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS messages_channel_id_id_idx ON messages(channel_id, id DESC);
    CREATE TABLE IF NOT EXISTS members (
      name TEXT PRIMARY KEY,
      color TEXT NOT NULL,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const defaults = [
    ['geral', 'geral', 'text', 'CANAIS DE TEXTO'],
    ['apresentacoes', 'apresentações', 'text', 'CANAIS DE TEXTO'],
    ['trabalho', 'trabalho', 'text', 'CANAIS DE TEXTO'],
    ['salinha', 'Salinha', 'voice', 'CANAIS DE VOZ'],
    ['reuniao', 'Reunião', 'voice', 'CANAIS DE VOZ'],
  ];
  for (const channel of defaults) {
    await pool.query(
      'INSERT INTO channels(id,name,type,category) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING',
      channel,
    );
  }
}

export const databaseReady = initializeDatabase();
