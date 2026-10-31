import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import pg from 'pg';

const { Client } = pg;
const database = 'littlecare';
const username = process.env.PGUSER || 'postgres';

if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== 'function') {
  throw new Error('Run this setup command directly in Terminal so the password can be entered privately.');
}

function promptHidden(question) {
  return new Promise((resolve, reject) => {
    stdout.write(question);
    stdin.setEncoding('utf8');
    stdin.setRawMode(true);
    stdin.resume();
    let value = '';

    function finish(error) {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    }

    function onData(key) {
      if (key === '\u0003') {
        finish(new Error('Setup cancelled.'));
      } else if (key === '\r' || key === '\n') {
        finish();
      } else if (key === '\u007f' || key === '\b') {
        value = value.slice(0, -1);
      } else {
        value += key;
      }
    }

    stdin.on('data', onData);
  });
}

const password = await promptHidden(`PostgreSQL password for role "${username}" (input hidden): `);
const client = new Client({
  host: '127.0.0.1',
  port: 5432,
  user: username,
  password,
  database: 'postgres',
  connectionTimeoutMillis: 5000
});

try {
  await client.connect();
  const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
  if (existing.rowCount === 0) {
    await client.query(`CREATE DATABASE ${database}`);
  }
  await client.end();

  const connectionUrl = new URL('postgresql://localhost:5432/littlecare');
  connectionUrl.username = username;
  connectionUrl.password = password;

  let existingEnv = '';
  try {
    await access(new URL('.env', import.meta.url), constants.F_OK);
    const { readFile } = await import('node:fs/promises');
    existingEnv = await readFile(new URL('.env', import.meta.url), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const lines = existingEnv
    .split(/\r?\n/)
    .filter((line) => line && !/^(DATABASE_URL|PGSSL|NODE_ENV)=/.test(line));
  lines.push(`DATABASE_URL=${connectionUrl.toString()}`, 'PGSSL=false');
  await writeFile(new URL('.env', import.meta.url), `${lines.join('\n')}\n`, { mode: 0o600 });

  console.log(`Connected successfully. The "${database}" database is ready.`);
  console.log('Connection details were saved to the ignored .env file.');
  console.log('Next, run: npm start');
} catch (error) {
  await client.end().catch(() => {});
  console.error('Could not set up PostgreSQL:', error.message);
  process.exitCode = 1;
}
