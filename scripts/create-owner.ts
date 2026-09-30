// Creates the platform owner. Usage: npm run create-owner -- "Owner name" owner@company.com
import { loadEnvConfig } from '@next/env';
import { AppError, getStore } from '../src/lib/store';

loadEnvConfig(process.cwd()); // same .env files as `next start` (DATABASE_URL, APP_URL), so the owner lands in the server's database

const [name, email] = process.argv.slice(2);
if (!name?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '')) {
  console.error('Usage: npm run create-owner -- "Owner name" owner@company.com');
  process.exit(1);
}
async function main() { // tsx runs this file as CommonJS: no top-level await
  const store = getStore();
  try {
    const token = await store.createOwner(name.trim(), email);
    console.log(`Owner created. One-time link to set the password (valid 24h):\n${process.env.APP_URL || 'http://127.0.0.1:3100'}/reset?token=${token}`);
  } catch (e) {
    if (e instanceof AppError) { console.error(e.message); process.exitCode = 1; } else throw e;
  } finally { await store.close(); }
}
void main();
