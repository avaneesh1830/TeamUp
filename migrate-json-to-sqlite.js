// One-time migration: data.json -> teamup.db (SQLite)
// Run with: node migrate-json-to-sqlite.js
// Safe to re-run — it refuses to overwrite an already-populated database.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const JSON_FILE = path.join(DATA_DIR, 'data.json');

if (!fs.existsSync(JSON_FILE)) {
  console.log('no data.json found — nothing to migrate (fresh SQLite db will be created on first run)');
  process.exit(0);
}

const dbApi = require('./db'); // creates teamup.db + schema
if (dbApi.allUsers().length > 0) {
  console.error('teamup.db already has users — refusing to migrate on top. Delete teamup.db first if you really want to re-import.');
  process.exit(1);
}

const old = JSON.parse(fs.readFileSync(JSON_FILE, 'utf8'));

for (const u of old.users || []) {
  dbApi.insertUser({
    srn: u.srn,
    name: u.name,
    gender: u.gender,
    branch: u.branch,
    cgpa: u.cgpa,
    email: u.email || '',
    whatsapp: u.whatsapp || '',
    bio: u.bio || '',
    github: u.github || '',
    salt: u.salt,
    pwHash: u.pwHash,
    tokens: u.tokens || [],
    projects: u.projects || [],
    domains: u.domains || [],
    pwChanges: u.pwChanges || [],
  });
}

for (const t of old.teams || []) {
  dbApi.insertTeam({
    id: t.id,
    leader: t.leader,
    branch: t.branch,
    description: t.description || '',
    mentor: t.mentor || null,
    domains: t.domains || [],
    members: t.members || [],
  });
}

for (const r of old.requests || []) {
  dbApi.insertRequest({ id: r.id, teamId: r.teamId, srn: r.srn, status: r.status, whatsapp: r.whatsapp || '' });
}

for (const i of old.invites || []) {
  dbApi.insertInvite({ id: i.id, teamId: i.teamId, srn: i.srn, status: i.status });
}

// keep history in original order (activity_log ids preserve it)
for (const e of old.log || []) {
  dbApi.logEventRaw(e.time, e.type, e.msg);
}

console.log(
  `migrated: ${(old.users || []).length} users, ${(old.teams || []).length} teams, ` +
  `${(old.requests || []).length} requests, ${(old.invites || []).length} invites, ${(old.log || []).length} log entries`
);
console.log(`data.json kept untouched as a backup at ${JSON_FILE}`);
