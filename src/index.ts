// @ts-nocheck
import fastify from 'fastify';
import { Client } from 'pg';

const app = fastify({ logger: false });

const DB_URL = process.env.DATABASE_URL || '';
const client = new Client({ connectionString: DB_URL });
let dbReady = false;
async function ensureDb() {
  if (dbReady) return;
  try {
    await client.connect();
    dbReady = true;
  } catch (e) {
    console.warn('DB connect error, retrying...');
    setTimeout(ensureDb, 2000);
  }
}
ensureDb();

type NodeRec = {
  id: string;
  name: string;
  version: number;
  code: string;
  plugin?: Function;
};

const loaded: Record<string, NodeRec> = {};
let lastRefresh = new Date().toISOString();

async function fetchActive() {
  await ensureDb();
  const res = await client.query(
    `SELECT id, name, version, code_text FROM nodes WHERE active = true`
  );
  return res.rows as { id: string; name: string; version: number; code_text: string }[];
}

function makePlugin(code: string, name: string) {
  try {
    const fn = new Function('module', 'exports', code);
    const mod = { exports: {} };
    fn(mod, mod.exports);
    const register = mod.exports;
    if (typeof register !== 'function') throw new Error('no export function');
    const plugin = (appInstance: any, opts: any, done: any) => {
      try {
        register(appInstance);
      } catch (e) {
        console.warn(`Node ${name} register error:`, e);
      }
      done();
    };
    return plugin;
  } catch (e) {
    console.warn(`Node ${name} eval error:`, e);
    return null;
  }
}

async function syncNodes() {
  const rows = await fetchActive();
  const seen = new Set<string>();
  for (const row of rows) {
    const { id, name, version, code_text } = row;
    seen.add(name);
    const existing = loaded[name];
    if (!existing) {
      const plugin = makePlugin(code_text, name);
      if (plugin) {
        app.register(plugin);
        loaded[name] = { id, name, version, code: code_text, plugin };
        console.log(`Loaded node ${name}@${version}`);
      }
    } else if (existing.version !== version) {
      if (existing.plugin) app.unregister(existing.plugin);
      const plugin = makePlugin(code_text, name);
      if (plugin) {
        app.register(plugin);
        loaded[name] = { id, name, version, code: code_text, plugin };
        console.log(`Reloaded node ${name}@${version}`);
      }
    }
  }
  // unload removed nodes
  for (const name of Object.keys(loaded)) {
    if (!seen.has(name)) {
      const rec = loaded[name];
      if (rec.plugin) app.unregister(rec.plugin);
      delete loaded[name];
      console.log(`Unloaded node ${name}`);
    }
  }
  lastRefresh = new Date().toISOString();
}

app.post('/__refresh', async (req, reply) => {
  try {
    await syncNodes();
    reply.send({ ok: true });
  } catch (e) {
    console.warn('Refresh error:', e);
    reply.code(500).send({ ok: false });
  }
});

app.get('/__health', async (req, reply) => {
  reply.send({
    ok: true,
    nodes_loaded: Object.keys(loaded).length,
    last_refresh: lastRefresh,
  });
});

setInterval(() => {
  syncNodes().catch((e) => console.warn('Periodic sync error:', e));
}, 60_000);

syncNodes().catch((e) => console.warn('Initial load error:', e));

const PORT = Number(process.env.PORT) || 3000;
app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
  console.log(`Server listening on ${PORT}`);
});