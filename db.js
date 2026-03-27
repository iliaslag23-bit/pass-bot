const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'vault.db');
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

let db;

async function getDb() {
  if (db) return db;
  const SQL = await initSqlJs();
  db = fs.existsSync(DB_PATH)
    ? new SQL.Database(fs.readFileSync(DB_PATH))
    : new SQL.Database();
  db.run(`
    CREATE TABLE IF NOT EXISTS passwords (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service TEXT NOT NULL UNIQUE,
      username TEXT,
      password TEXT NOT NULL,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  persist();
  return db;
}

function persist() {
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

function rowsToObjects(result) {
  if (!result.length) return [];
  const cols = result[0].columns;
  return result[0].values.map(row => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}

async function savePassword(service, username, password, notes) {
  const d = await getDb();
  const key = service.toLowerCase();
  const existing = rowsToObjects(d.exec('SELECT id FROM passwords WHERE service = ?', [key]));

  if (existing.length) {
    d.run(
      'UPDATE passwords SET username=?, password=?, notes=?, updated_at=CURRENT_TIMESTAMP WHERE service=?',
      [username, password, notes, key]
    );
    persist();
    return 'updated';
  } else {
    d.run(
      'INSERT INTO passwords (service, username, password, notes) VALUES (?,?,?,?)',
      [key, username, password, notes]
    );
    persist();
    return 'created';
  }
}

async function getPassword(service) {
  const d = await getDb();
  const rows = rowsToObjects(d.exec('SELECT * FROM passwords WHERE service LIKE ? LIMIT 1', [`%${service.toLowerCase()}%`]));
  return rows[0] || null;
}

async function listServices() {
  const d = await getDb();
  return rowsToObjects(d.exec('SELECT service, username, updated_at FROM passwords ORDER BY service'));
}

async function deletePassword(service) {
  const d = await getDb();
  const before = rowsToObjects(d.exec('SELECT id FROM passwords WHERE service LIKE ?', [`%${service.toLowerCase()}%`]));
  if (!before.length) return false;
  d.run('DELETE FROM passwords WHERE service LIKE ?', [`%${service.toLowerCase()}%`]);
  persist();
  return true;
}

async function countPasswords() {
  const d = await getDb();
  const rows = rowsToObjects(d.exec('SELECT COUNT(*) as total FROM passwords'));
  return rows[0]?.total || 0;
}

module.exports = { savePassword, getPassword, listServices, deletePassword, countPasswords };
