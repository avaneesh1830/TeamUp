// SQLite persistence layer. better-sqlite3 is synchronous, so route handlers
// in server.js stay exactly as simple as they were with the old in-memory store —
// only the storage mechanism changed, not the API.
const path = require('path');
const Database = require('better-sqlite3');

const DB_FILE = path.join(process.env.DATA_DIR || __dirname, 'teamup.db');
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL'); // safe concurrent reads while a write is in progress
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    srn TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    gender TEXT NOT NULL,
    branch TEXT NOT NULL,
    cgpa REAL NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    whatsapp TEXT NOT NULL DEFAULT '',
    bio TEXT NOT NULL DEFAULT '',
    github TEXT NOT NULL DEFAULT '',
    salt TEXT NOT NULL,
    pw_hash TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS user_tokens (
    token TEXT PRIMARY KEY,
    srn TEXT NOT NULL REFERENCES users(srn) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS user_pw_changes (
    srn TEXT NOT NULL REFERENCES users(srn) ON DELETE CASCADE,
    ts INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS user_domains (
    srn TEXT NOT NULL REFERENCES users(srn) ON DELETE CASCADE,
    domain TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS user_projects (
    id TEXT PRIMARY KEY,
    srn TEXT NOT NULL REFERENCES users(srn) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    link TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS teams (
    id TEXT PRIMARY KEY,
    leader_srn TEXT NOT NULL,
    branch TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    mentor_id TEXT
  );
  CREATE TABLE IF NOT EXISTS team_domains (
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    domain TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS team_members (
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    srn TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS requests (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    srn TEXT NOT NULL,
    status TEXT NOT NULL,
    whatsapp TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS invites (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    srn TEXT NOT NULL,
    status TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    time TEXT NOT NULL,
    type TEXT NOT NULL,
    msg TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS otps (
    srn TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    expires INTEGER NOT NULL,
    tries INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS pending_regs (
    srn TEXT PRIMARY KEY,
    user_json TEXT NOT NULL,
    code TEXT NOT NULL,
    expires INTEGER NOT NULL,
    tries INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_team_members_srn ON team_members(srn);
  CREATE INDEX IF NOT EXISTS idx_requests_team ON requests(team_id, status);
  CREATE INDEX IF NOT EXISTS idx_requests_srn ON requests(srn);
  CREATE INDEX IF NOT EXISTS idx_invites_team ON invites(team_id, status);
  CREATE INDEX IF NOT EXISTS idx_invites_srn ON invites(srn);
`);

// ---------- users ----------
const stUserBySrn = db.prepare('SELECT * FROM users WHERE srn = ?');
const stAllUsers = db.prepare('SELECT * FROM users');
const stTokens = db.prepare('SELECT token FROM user_tokens WHERE srn = ?');
const stPwChanges = db.prepare('SELECT ts FROM user_pw_changes WHERE srn = ?');
const stDomains = db.prepare('SELECT domain FROM user_domains WHERE srn = ?');
const stProjects = db.prepare('SELECT id, title, description, link FROM user_projects WHERE srn = ? ORDER BY rowid');

function rowToUser(row) {
  if (!row) return null;
  return {
    srn: row.srn,
    name: row.name,
    gender: row.gender,
    branch: row.branch,
    cgpa: row.cgpa,
    email: row.email,
    whatsapp: row.whatsapp,
    bio: row.bio,
    github: row.github,
    salt: row.salt,
    pwHash: row.pw_hash,
    tokens: stTokens.all(row.srn).map((r) => r.token),
    pwChanges: stPwChanges.all(row.srn).map((r) => r.ts),
    domains: stDomains.all(row.srn).map((r) => r.domain),
    projects: stProjects.all(row.srn),
  };
}

function userBySrn(srn) {
  return rowToUser(stUserBySrn.get(srn));
}
const stSrnByToken = db.prepare('SELECT srn FROM user_tokens WHERE token = ?');
function userByToken(token) {
  const row = stSrnByToken.get(token);
  return row ? userBySrn(row.srn) : null;
}
function allUsers() {
  return stAllUsers.all().map(rowToUser);
}
function emailTaken(email, excludeSrn) {
  return !!db
    .prepare('SELECT 1 FROM users WHERE email = ? AND srn != ?')
    .get(email, excludeSrn || '');
}

// ---- fast student search: column filters run in SQL; only the returned page is hydrated ----
const stSrnsInTeams = db.prepare('SELECT DISTINCT srn FROM team_members');
function srnsInTeams() {
  return new Set(stSrnsInTeams.all().map((r) => r.srn));
}

// returns RAW user rows (branch/gender/cgpa/name/srn present, but NOT tokens/domains/projects)
// applying every filter that can be expressed in SQL. grade maps to cgpa ranges.
function searchUserRows({ q, branch, gender, grade, domain }) {
  const where = [];
  const args = [];
  if (q) {
    const like = '%' + String(q).toLowerCase() + '%';
    where.push('(LOWER(name) LIKE ? OR LOWER(srn) LIKE ?)');
    args.push(like, like);
  }
  if (branch) { where.push('branch = ?'); args.push(branch); }
  if (gender) { where.push('gender = ?'); args.push(gender); }
  if (grade === 'A') where.push('cgpa >= 8');
  else if (grade === 'B') where.push('cgpa >= 7 AND cgpa < 8');
  else if (grade === 'C') where.push('cgpa < 7');
  if (domain) { where.push('srn IN (SELECT srn FROM user_domains WHERE domain = ?)'); args.push(domain); }
  const sql = 'SELECT * FROM users' + (where.length ? ' WHERE ' + where.join(' AND ') : '');
  return db.prepare(sql).all(...args);
}

// attach domains + projects to a raw row so publicUser() can consume it — call ONLY on the
// small returned page, never on the full candidate set.
function attachProfile(row) {
  return {
    srn: row.srn, name: row.name, gender: row.gender, branch: row.branch, cgpa: row.cgpa,
    email: row.email, whatsapp: row.whatsapp, bio: row.bio, github: row.github,
    domains: stDomains.all(row.srn).map((r) => r.domain),
    projects: stProjects.all(row.srn),
  };
}

const stInsertUser = db.prepare(`
  INSERT INTO users (srn, name, gender, branch, cgpa, email, whatsapp, bio, github, salt, pw_hash)
  VALUES (@srn, @name, @gender, @branch, @cgpa, @email, @whatsapp, @bio, @github, @salt, @pwHash)
`);
const stInsertToken = db.prepare('INSERT INTO user_tokens (token, srn) VALUES (?, ?)');
const stInsertProject = db.prepare(`
  INSERT INTO user_projects (id, srn, title, description, link) VALUES (?, ?, ?, ?, ?)
`);
const stInsertDomain = db.prepare('INSERT INTO user_domains (srn, domain) VALUES (?, ?)');
const stInsertPwChange = db.prepare('INSERT INTO user_pw_changes (srn, ts) VALUES (?, ?)');

const insertUser = db.transaction((u) => {
  stInsertUser.run(u);
  u.tokens.forEach((t) => stInsertToken.run(t, u.srn));
  u.projects.forEach((p) => stInsertProject.run(p.id, u.srn, p.title, p.description, p.link));
  u.domains.forEach((d) => stInsertDomain.run(u.srn, d));
  u.pwChanges.forEach((ts) => stInsertPwChange.run(u.srn, ts));
});

const stUpdateUser = db.prepare(`
  UPDATE users SET name=@name, gender=@gender, branch=@branch, cgpa=@cgpa, email=@email,
    whatsapp=@whatsapp, bio=@bio, github=@github, salt=@salt, pw_hash=@pwHash WHERE srn=@srn
`);
const stDelTokens = db.prepare('DELETE FROM user_tokens WHERE srn = ?');
const stDelProjects = db.prepare('DELETE FROM user_projects WHERE srn = ?');
const stDelDomains = db.prepare('DELETE FROM user_domains WHERE srn = ?');
const stDelPwChanges = db.prepare('DELETE FROM user_pw_changes WHERE srn = ?');

// rewrites the user row + all its child lists (tokens/projects/domains/pwChanges)
// from the in-memory object — simple and correct at this scale (a user has at most ~10 rows in any child table)
const saveUser = db.transaction((u) => {
  stUpdateUser.run(u);
  stDelTokens.run(u.srn);
  u.tokens.forEach((t) => stInsertToken.run(t, u.srn));
  stDelProjects.run(u.srn);
  u.projects.forEach((p) => stInsertProject.run(p.id, u.srn, p.title, p.description, p.link));
  stDelDomains.run(u.srn);
  u.domains.forEach((d) => stInsertDomain.run(u.srn, d));
  stDelPwChanges.run(u.srn);
  u.pwChanges.forEach((ts) => stInsertPwChange.run(u.srn, ts));
});

const deleteUser = db.prepare('DELETE FROM users WHERE srn = ?'); // cascades tokens/projects/domains/pwChanges

// ---------- teams ----------
const stTeamById = db.prepare('SELECT * FROM teams WHERE id = ?');
const stAllTeams = db.prepare('SELECT * FROM teams');
const stTeamOfSrn = db.prepare(`
  SELECT t.* FROM teams t JOIN team_members m ON m.team_id = t.id WHERE m.srn = ?
`);
const stTeamDomains = db.prepare('SELECT domain FROM team_domains WHERE team_id = ?');
const stTeamMembers = db.prepare('SELECT srn FROM team_members WHERE team_id = ? ORDER BY rowid');

function rowToTeam(row) {
  if (!row) return null;
  return {
    id: row.id,
    leader: row.leader_srn,
    branch: row.branch,
    description: row.description,
    mentor: row.mentor_id,
    domains: stTeamDomains.all(row.id).map((r) => r.domain),
    members: stTeamMembers.all(row.id).map((r) => r.srn),
  };
}

function teamById(id) {
  return rowToTeam(stTeamById.get(id));
}
function teamOf(srn) {
  return rowToTeam(stTeamOfSrn.get(srn));
}
function allTeams() {
  return stAllTeams.all().map(rowToTeam);
}

const stInsertTeam = db.prepare(`
  INSERT INTO teams (id, leader_srn, branch, description, mentor_id) VALUES (@id, @leader, @branch, @description, @mentor)
`);
const stInsertTeamDomain = db.prepare('INSERT INTO team_domains (team_id, domain) VALUES (?, ?)');
const stInsertTeamMember = db.prepare('INSERT INTO team_members (team_id, srn) VALUES (?, ?)');

const insertTeam = db.transaction((t) => {
  stInsertTeam.run(t);
  t.domains.forEach((d) => stInsertTeamDomain.run(t.id, d));
  t.members.forEach((s) => stInsertTeamMember.run(t.id, s));
});

const stUpdateTeam = db.prepare(`
  UPDATE teams SET leader_srn=@leader, branch=@branch, description=@description, mentor_id=@mentor WHERE id=@id
`);
const stDelTeamDomains = db.prepare('DELETE FROM team_domains WHERE team_id = ?');
const stDelTeamMembers = db.prepare('DELETE FROM team_members WHERE team_id = ?');

const saveTeam = db.transaction((t) => {
  stUpdateTeam.run(t);
  stDelTeamDomains.run(t.id);
  t.domains.forEach((d) => stInsertTeamDomain.run(t.id, d));
  stDelTeamMembers.run(t.id);
  t.members.forEach((s) => stInsertTeamMember.run(t.id, s));
});

const deleteTeam = db.prepare('DELETE FROM teams WHERE id = ?'); // cascades domains/members

// ---------- requests ----------
const rowToRequest = (r) => (r ? { id: r.id, teamId: r.team_id, srn: r.srn, status: r.status, whatsapp: r.whatsapp } : null);
const stRequestById = db.prepare('SELECT * FROM requests WHERE id = ?');
const stRequestsForTeam = db.prepare("SELECT * FROM requests WHERE team_id = ? AND status = 'pending'");
const stRequestsForSrn = db.prepare('SELECT * FROM requests WHERE srn = ?');
const stInsertRequest = db.prepare(`
  INSERT INTO requests (id, team_id, srn, status, whatsapp) VALUES (@id, @teamId, @srn, @status, @whatsapp)
`);
const stFindPendingRequest = db.prepare(
  "SELECT * FROM requests WHERE team_id = ? AND srn = ? AND status = 'pending'"
);
const stUpdateRequestStatus = db.prepare('UPDATE requests SET status = ? WHERE id = ?');
const stCloseTeamRequests = db.prepare(
  "UPDATE requests SET status = 'rejected' WHERE team_id = ? AND status = 'pending'"
);
const stCloseTeamRequestsCancelled = db.prepare(
  "UPDATE requests SET status = 'cancelled' WHERE team_id = ? AND status = 'pending'"
);
const stDeleteRequestsForSrn = db.prepare('DELETE FROM requests WHERE srn = ?');
const stDeleteInvitesForSrn = db.prepare('DELETE FROM invites WHERE srn = ?');

function requestById(id) {
  return rowToRequest(stRequestById.get(id));
}
function pendingRequestsForTeam(teamId) {
  return stRequestsForTeam.all(teamId).map(rowToRequest);
}
function requestsForSrn(srn) {
  return stRequestsForSrn.all(srn).map(rowToRequest);
}
function findPendingRequest(teamId, srn) {
  return rowToRequest(stFindPendingRequest.get(teamId, srn));
}
function insertRequest(r) {
  stInsertRequest.run(r);
}
function updateRequestStatus(id, status) {
  stUpdateRequestStatus.run(status, id);
}
function closeTeamRequests(teamId) {
  stCloseTeamRequests.run(teamId);
}
function closeTeamRequestsCancelled(teamId) {
  stCloseTeamRequestsCancelled.run(teamId);
}
function deleteRequestsForSrn(srn) {
  stDeleteRequestsForSrn.run(srn);
}
function deleteInvitesForSrn(srn) {
  stDeleteInvitesForSrn.run(srn);
}

// ---------- invites ----------
const rowToInvite = (i) => (i ? { id: i.id, teamId: i.team_id, srn: i.srn, status: i.status } : null);
const stInviteById = db.prepare('SELECT * FROM invites WHERE id = ?');
const stInvitesForTeam = db.prepare('SELECT * FROM invites WHERE team_id = ?');
const stInvitesForSrn = db.prepare('SELECT * FROM invites WHERE srn = ?');
const stInsertInvite = db.prepare('INSERT INTO invites (id, team_id, srn, status) VALUES (?, ?, ?, ?)');
const stFindPendingInvite = db.prepare(
  "SELECT * FROM invites WHERE team_id = ? AND srn = ? AND status = 'pending'"
);
const stUpdateInviteStatus = db.prepare('UPDATE invites SET status = ? WHERE id = ?');
const stCloseTeamInvites = db.prepare(
  "UPDATE invites SET status = 'cancelled' WHERE team_id = ? AND status = 'pending'"
);

function inviteById(id) {
  return rowToInvite(stInviteById.get(id));
}
function invitesForTeam(teamId) {
  return stInvitesForTeam.all(teamId).map(rowToInvite);
}
function invitesForSrn(srn) {
  return stInvitesForSrn.all(srn).map(rowToInvite);
}
function findPendingInvite(teamId, srn) {
  return rowToInvite(stFindPendingInvite.get(teamId, srn));
}
function insertInvite(i) {
  stInsertInvite.run(i.id, i.teamId, i.srn, i.status);
}
function updateInviteStatus(id, status) {
  stUpdateInviteStatus.run(status, id);
}
function closeTeamInvites(teamId) {
  stCloseTeamInvites.run(teamId);
}

// ---------- activity log ----------
const stInsertLog = db.prepare('INSERT INTO activity_log (time, type, msg) VALUES (?, ?, ?)');
const stRecentLog = db.prepare('SELECT time, type, msg FROM activity_log ORDER BY id DESC LIMIT ?');
function logEvent(type, msg) {
  stInsertLog.run(new Date().toISOString(), type, msg);
}
// used by the JSON->SQLite migration to preserve original timestamps
function logEventRaw(time, type, msg) {
  stInsertLog.run(time, type, msg);
}
function recentLog(limit = 200) {
  return stRecentLog.all(limit);
}

// ---------- OTPs (password reset) ----------
const stOtpGet = db.prepare('SELECT * FROM otps WHERE srn = ?');
const stOtpSet = db.prepare(`
  INSERT INTO otps (srn, code, expires, tries) VALUES (?, ?, ?, 0)
  ON CONFLICT(srn) DO UPDATE SET code=excluded.code, expires=excluded.expires, tries=0
`);
const stOtpBumpTries = db.prepare('UPDATE otps SET tries = tries + 1 WHERE srn = ?');
const stOtpDelete = db.prepare('DELETE FROM otps WHERE srn = ?');
const stOtpPrune = db.prepare('DELETE FROM otps WHERE expires < ?');
function getOtp(srn) {
  return stOtpGet.get(srn) || null;
}
function setOtp(srn, code, expires) {
  stOtpSet.run(srn, code, expires);
}
function bumpOtpTries(srn) {
  stOtpBumpTries.run(srn);
}
function deleteOtp(srn) {
  stOtpDelete.run(srn);
}

// ---------- pending registrations (awaiting email OTP) ----------
const stRegGet = db.prepare('SELECT * FROM pending_regs WHERE srn = ?');
const stRegSet = db.prepare(`
  INSERT INTO pending_regs (srn, user_json, code, expires, tries) VALUES (?, ?, ?, ?, 0)
  ON CONFLICT(srn) DO UPDATE SET user_json=excluded.user_json, code=excluded.code, expires=excluded.expires, tries=0
`);
const stRegBumpTries = db.prepare('UPDATE pending_regs SET tries = tries + 1 WHERE srn = ?');
const stRegDelete = db.prepare('DELETE FROM pending_regs WHERE srn = ?');
const stRegPrune = db.prepare('DELETE FROM pending_regs WHERE expires < ?');
function getPendingReg(srn) {
  const row = stRegGet.get(srn);
  if (!row) return null;
  return { user: JSON.parse(row.user_json), code: row.code, expires: row.expires, tries: row.tries };
}
function setPendingReg(srn, rec) {
  stRegSet.run(srn, JSON.stringify(rec.user), rec.code, rec.expires);
}
function bumpRegTries(srn) {
  stRegBumpTries.run(srn);
}
function deletePendingReg(srn) {
  stRegDelete.run(srn);
}

// prune anything expired from a previous run
stOtpPrune.run(Date.now());
stRegPrune.run(Date.now());

module.exports = {
  userBySrn, userByToken, allUsers, emailTaken, insertUser, saveUser, deleteUser,
  srnsInTeams, searchUserRows, attachProfile,
  teamById, teamOf, allTeams, insertTeam, saveTeam, deleteTeam,
  requestById, pendingRequestsForTeam, requestsForSrn, findPendingRequest, insertRequest, updateRequestStatus, closeTeamRequests,
  closeTeamRequestsCancelled, deleteRequestsForSrn, deleteInvitesForSrn,
  inviteById, invitesForTeam, invitesForSrn, findPendingInvite, insertInvite, updateInviteStatus, closeTeamInvites,
  logEvent, logEventRaw, recentLog,
  getOtp, setOtp, bumpOtpTries, deleteOtp,
  getPendingReg, setPendingReg, bumpRegTries, deletePendingReg,
};
