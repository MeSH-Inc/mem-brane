import { openDatabase } from '../server/db/index.js';
import { config } from '../server/app/config.js';
const db = openDatabase(config.DATABASE_PATH);
console.log('mem-brane migrations applied (SQLite WAL)');
db.close();
