// Hands the owner account to the platform's owner: prints a one-time link (24h) where they choose the sign-in email and
// password. The previous owner's sessions, reset links and recovery code end when the link is used.
// Usage: npm run owner-handover   (with the production DATABASE_URL and APP_URL in the environment)
import { loadEnvConfig } from '@next/env';
import { AppError, getStore } from '../src/lib/store';

loadEnvConfig(process.cwd());
async function main() {
  const store = getStore();
  try {
    const token = await store.ownerHandover();
    console.log(`One-time owner handover link (valid 24h):\n${process.env.APP_URL || 'http://127.0.0.1:3100'}/owner?token=${token}`);
  } catch (e) {
    if (e instanceof AppError) { console.error(e.message); process.exitCode = 1; } else throw e;
  } finally { await store.close(); }
}
void main();
