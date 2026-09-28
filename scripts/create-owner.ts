// Creates the platform owner. Usage: npm run create-owner -- "Owner name" owner@company.com
import { loadEnvConfig } from '@next/env';
import { AppError, getStore } from '../src/lib/store';

loadEnvConfig(process.cwd()); // same .env files as `next start`, so the owner lands in the server's database

const [name, email] = process.argv.slice(2);
if (!name?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '')) {
  console.error('Usage: npm run create-owner -- "Owner name" owner@company.com');
  process.exit(1);
}
let token: string;
try { token = getStore().createOwner(name.trim(), email); }
catch (e) { if (e instanceof AppError) { console.error(e.message); process.exit(1); } throw e; }
console.log(`Owner created. One-time link to set the password (valid 24h):\n${process.env.APP_URL || 'http://127.0.0.1:3100'}/reset?token=${token}`);
