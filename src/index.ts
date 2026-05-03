// @ts-nocheck
import fastify from 'fastify';
import { Client } from 'pg';

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  const helpers = {
    client,
    async markStatus(name: string, status: string, errorText: string = '') {
      await client.query(
        `UPDATE nodes SET status=$1, last_loaded_at=now(), error_text=$2, load_count=load_count+1 WHERE name=$3`,
        [status, errorText, name]
      );
    },
  };

  const app = fastify();

  let res = await client.query(
    `SELECT code_text FROM nodes WHERE name='_shell_orchestrator' AND active=true AND (status='deployed' OR status='pending') ORDER BY version DESC LIMIT 1`
  );

  if (res.rowCount === 0) {
    res = await client.query(
      `SELECT code_text FROM nodes WHERE name='_shell_orchestrator' ORDER BY version DESC LIMIT 1`
    );
  }

  const code = res.rows[0]?.code_text;
  if (!code) throw new Error('No orchestrator code found');

  await helpers.markStatus('_shell_orchestrator', 'deploying');
  const mod = { exports: {} };
  const fn = new Function('module', 'exports', 'require', 'app', 'helpers', code);
  await fn(mod, mod.exports, require, app, helpers);
  await helpers.markStatus('_shell_orchestrator', 'deployed');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});