import { openDatabase } from '../server/db/index.js';
import { config } from '../server/app/config.js';
import { createAuth } from '../server/auth/index.js';
import { createBrane, createBlock } from '../server/services/content.js';
if (process.env.NODE_ENV === 'production')
  throw new Error('Development seed is disabled in production');
const db = openDatabase(config.DATABASE_PATH),
  auth = createAuth(db);
const email = process.env.SEED_EMAIL ?? 'hello@mem-brane.local',
  password = process.env.SEED_PASSWORD ?? 'mem-brane-local-only';
let user = db.prepare('SELECT id FROM "user" WHERE email=?').get(email) as
  { id: string } | undefined;
if (!user)
  user = (await auth.api.signUpEmail({ body: { email, password, name: 'Local thinker' } })).user;
if (!db.prepare('SELECT id FROM branes WHERE owner_id=?').get(user.id)) {
  const brane = createBrane(db, user.id, 'A little room to think');
  createBlock(
    db,
    user.id,
    'text',
    {
      format: 'text',
      text: 'What happens when an idea has room to grow?\n\nDrag on empty space to make a text block. Write something, then choose Use as context. Your next run will remember exactly what you submitted.',
    },
    brane.id,
    { x: 80, y: 100, width: 350, height: 270 },
  );
}
console.log(
  `Seed ready. Email: ${email}. Password: ${process.env.SEED_PASSWORD ? 'your SEED_PASSWORD' : 'mem-brane-local-only'}`,
);
db.close();
