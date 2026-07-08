const express = require('express');
const compression = require('compression');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(compression()); // gzip responses — the teams list shrinks ~10x
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- tiny JSON-file database ----------
// DATA_DIR lets hosting platforms point this at a persistent volume
const DATA_FILE = path.join(process.env.DATA_DIR || __dirname, 'data.json');
let db = { users: [], teams: [], requests: [] };
if (fs.existsSync(DATA_FILE)) {
  db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}
// migrate older records to the current shape
db.users.forEach((u) => {
  if (!u.projects) u.projects = [];
  if (u.github === undefined) u.github = '';
  if (!u.domains) u.domains = []; // domains they're interested in working on
  if (u.whatsapp === undefined) u.whatsapp = '';
});
db.teams.forEach((t) => {
  if (!t.memberNotes) t.memberNotes = {};
  if (t.mentor === undefined) t.mentor = null;
});
if (!db.log) db.log = [];
if (!db.invites) db.invites = []; // leader -> student invitations

// atomic write: never leaves a half-written data.json even if the process dies mid-save
const save = () => {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
};

// activity log: account creation, team joins/leaves, etc.
const logEvent = (type, msg) => {
  db.log.push({ time: new Date().toISOString(), type, msg });
  if (db.log.length > 5000) db.log = db.log.slice(-4000); // keep it bounded
};

// ---------- professors (mentors) ----------
const PROF_FILE = path.join(__dirname, 'professors.json');
let professors = [];
if (fs.existsSync(PROF_FILE)) {
  professors = JSON.parse(fs.readFileSync(PROF_FILE, 'utf8'));
}

// ---------- helpers ----------
const TEAM_SIZE = 4;
const BRANCHES = ['CSE', 'AIML', 'ECE'];
// the official domain list — profile interests must come from here
const DOMAINS = [
  'AI / Machine Learning',
  'Web Development',
  'Mobile App Development',
  'Data Science',
  'Cybersecurity',
  'Blockchain',
  'IoT / Embedded Systems',
  'Cloud Computing',
  'AR / VR',
  'Robotics',
];
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const gradeOf = (cgpa) => (cgpa >= 8 ? 'A' : cgpa >= 7 ? 'B' : 'C');
const teamOf = (srn) => db.teams.find((t) => t.members.includes(srn));
const userBySrn = (srn) => db.users.find((u) => u.srn === srn);
const isHttp = (s) => /^https?:\/\/\S+$/i.test(s);
// normalize a WhatsApp number: '' if empty, null if invalid, else digits with country code
function normWa(x) {
  let wa = String(x || '').replace(/\D/g, '');
  if (!wa) return '';
  if (wa.length === 10) wa = '91' + wa; // assume India if no country code
  if (wa.length < 11 || wa.length > 15) return null;
  return wa;
}

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const user = token && db.users.find((u) => u.token === token);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  req.user = user;
  next();
}

// Which slots are still open on a team?
function slotInfo(team) {
  const members = team.members.map(userBySrn);
  const remaining = TEAM_SIZE - members.length;
  const grades = members.map((m) => gradeOf(m.cgpa));
  const boys = members.filter((m) => m.gender === 'M').length;
  const girls = members.length - boys;
  // Grades the team is still missing (needs at least one A, one B, one C)
  const missing = ['A', 'B', 'C'].filter((g) => !grades.includes(g));
  // A grade slot is open if, after taking it, the other missing grades still fit
  const openGrades =
    remaining === 0
      ? []
      : ['A', 'B', 'C'].filter(
          (g) => missing.filter((x) => x !== g).length <= remaining - 1
        );
  return {
    remaining,
    boys,
    girls,
    missing,
    openGrades,
    boysOpen: remaining > 0 && boys < 3, // final team needs 1-3 male
    girlsOpen: remaining > 0 && girls < 3, // and 1-3 female
  };
}

// null if user can join, otherwise a reason string
function joinBlock(team, user) {
  if (user.branch !== team.branch)
    return `Only ${team.branch} students can join this team (you are ${user.branch})`;
  const s = slotInfo(team);
  if (s.remaining === 0) return 'Team is full';
  const g = gradeOf(user.cgpa);
  if (!s.openGrades.includes(g))
    return `No ${g}-grade slot left (team still needs: ${s.missing.join(', ')})`;
  if (user.gender === 'M' && !s.boysOpen) return 'Male slots full (max 3)';
  if (user.gender === 'F' && !s.girlsOpen) return 'Female slots full (max 3)';
  return null;
}

const publicUser = (u) => ({
  srn: u.srn,
  name: u.name,
  gender: u.gender,
  branch: u.branch,
  grade: gradeOf(u.cgpa),
  projects: u.projects || [],
  github: u.github || '',
  domains: u.domains || [],
  whatsapp: u.whatsapp || '',
});

function teamView(team, viewer) {
  const s = slotInfo(team);
  const myReq =
    viewer &&
    db.requests.find(
      (r) => r.teamId === team.id && r.srn === viewer.srn && r.status === 'pending'
    );
  return {
    id: team.id,
    domain: team.domain,
    branch: team.branch,
    leader: team.leader,
    memberNotes: team.memberNotes || {},
    mentor: team.mentor ? professors.find((p) => p.id === team.mentor) || null : null,
    members: team.members.map((srn) => publicUser(userBySrn(srn))),
    slots: s,
    requested: !!myReq,
    joinBlock: viewer ? (teamOf(viewer.srn) ? 'Already in a team' : joinBlock(team, viewer)) : null,
  };
}

// ---------- auth routes ----------
app.post('/api/register', (req, res) => {
  const { name, srn, gender, branch, cgpa, password } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  if (name.trim().length > 60) return res.status(400).json({ error: 'Name too long (max 60 chars)' });
  if (!srn || !srn.trim() || srn.trim().length > 20) return res.status(400).json({ error: 'SRN is required (max 20 chars)' });
  if (gender !== 'M' && gender !== 'F') return res.status(400).json({ error: 'Select male or female' });
  if (!BRANCHES.includes(branch)) return res.status(400).json({ error: 'Select your branch (CSE / AIML / ECE)' });
  const c = Number(cgpa);
  if (!(c >= 0 && c <= 10)) return res.status(400).json({ error: 'CGPA must be between 0 and 10' });
  if (!password || password.length < 4)
    return res.status(400).json({ error: 'Password must be at least 4 characters' });
  const id = srn.trim().toUpperCase();
  if (userBySrn(id)) return res.status(400).json({ error: 'This SRN is already registered' });
  const wa = normWa(req.body.whatsapp);
  if (wa === null) return res.status(400).json({ error: 'Enter a valid WhatsApp number (10 digits, or with country code)' });
  const salt = crypto.randomBytes(8).toString('hex');
  const user = {
    srn: id,
    name: name.trim(),
    gender,
    branch,
    cgpa: c,
    projects: [],
    github: '',
    domains: [],
    whatsapp: wa,
    salt,
    pwHash: hashPw(password, salt),
    token: crypto.randomUUID(),
  };
  db.users.push(user);
  logEvent('account_created', `${user.name} (${user.srn}, ${branch}) registered`);
  save();
  res.json({ token: user.token });
});

app.post('/api/login', (req, res) => {
  const { srn, password } = req.body;
  const user = userBySrn((srn || '').trim().toUpperCase());
  if (!user || hashPw(password || '', user.salt) !== user.pwHash)
    return res.status(400).json({ error: 'Wrong SRN or password' });
  user.token = crypto.randomUUID();
  save();
  res.json({ token: user.token });
});

// ---------- me / profile ----------
app.get('/api/me', auth, (req, res) => {
  const me = req.user;
  const team = teamOf(me.srn);
  const incoming =
    team && team.leader === me.srn
      ? db.requests
          .filter((r) => r.teamId === team.id && r.status === 'pending')
          .map((r) => ({ id: r.id, user: publicUser(userBySrn(r.srn)), whatsapp: r.whatsapp || '' }))
      : [];
  const outgoing = db.requests
    .filter((r) => r.srn === me.srn)
    .map((r) => {
      const t = db.teams.find((x) => x.id === r.teamId);
      return { id: r.id, teamDomain: t ? t.domain : '(deleted team)', status: r.status };
    });
  // invitations sent TO me by team leaders
  const invites = db.invites
    .filter((i) => i.srn === me.srn)
    .map((i) => {
      const t = db.teams.find((x) => x.id === i.teamId);
      const leader = t && userBySrn(t.leader);
      return {
        id: i.id,
        status: i.status,
        teamDomain: t ? t.domain : '(disbanded team)',
        teamBranch: t ? t.branch : '',
        leaderName: leader ? leader.name : '',
      };
    });
  // invitations I have sent as a leader
  const sentInvites =
    team && team.leader === me.srn
      ? db.invites
          .filter((i) => i.teamId === team.id)
          .map((i) => {
            const u = userBySrn(i.srn);
            return { id: i.id, srn: i.srn, name: u ? u.name : i.srn, status: i.status };
          })
      : [];
  res.json({
    user: { ...publicUser(me), cgpa: me.cgpa },
    team: team ? teamView(team, me) : null,
    incoming,
    outgoing,
    invites,
    sentInvites,
  });
});

// edit my details (SRN is fixed — it's the account key)
app.post('/api/profile', auth, (req, res) => {
  const { name, gender, branch, cgpa, password } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  if (name.trim().length > 60) return res.status(400).json({ error: 'Name too long (max 60 chars)' });
  if (gender !== 'M' && gender !== 'F') return res.status(400).json({ error: 'Select male or female' });
  if (!BRANCHES.includes(branch)) return res.status(400).json({ error: 'Select your branch (CSE / AIML / ECE)' });
  const c = Number(cgpa);
  if (!(c >= 0 && c <= 10)) return res.status(400).json({ error: 'CGPA must be between 0 and 10' });
  if (password && password.length < 4)
    return res.status(400).json({ error: 'New password must be at least 4 characters' });

  // if in a team, the change must not break the team's rules
  const team = teamOf(req.user.srn);
  if (team) {
    if (branch !== team.branch)
      return res.status(400).json({ error: `You are in a ${team.branch} team — leave it before changing branch` });
    const sim = team.members.map((s) =>
      s === req.user.srn ? { gender, cgpa: c } : userBySrn(s)
    );
    const boys = sim.filter((m) => m.gender === 'M').length;
    const girls = sim.length - boys;
    if (boys > 3 || girls > 3)
      return res.status(400).json({ error: "This change would break your team's gender mix (max 3 male / 3 female)" });
    const grades = sim.map((m) => gradeOf(m.cgpa));
    const missing = ['A', 'B', 'C'].filter((g) => !grades.includes(g));
    if (missing.length > TEAM_SIZE - sim.length)
      return res.status(400).json({
        error: `This change would break your team's grade mix (team would still need ${missing.join(', ')} with only ${TEAM_SIZE - sim.length} seat${TEAM_SIZE - sim.length === 1 ? '' : 's'} left)`,
      });
  }

  const wa = normWa(req.body.whatsapp);
  if (wa === null) return res.status(400).json({ error: 'Enter a valid WhatsApp number (10 digits, or with country code)' });

  req.user.name = name.trim();
  req.user.gender = gender;
  req.user.branch = branch;
  req.user.cgpa = c;
  req.user.whatsapp = wa;
  if (password) {
    req.user.salt = crypto.randomBytes(8).toString('hex');
    req.user.pwHash = hashPw(password, req.user.salt);
  }
  save();
  res.json({ ok: true });
});

// set the domains I'm interested in — must come from the official list, no free text
app.post('/api/profile/domains', auth, (req, res) => {
  const domains = req.body.domains;
  if (!Array.isArray(domains)) return res.status(400).json({ error: 'Domains must be a list' });
  const invalid = domains.filter((d) => !DOMAINS.includes(d));
  if (invalid.length) return res.status(400).json({ error: `Not in the domain list: ${invalid.join(', ')}` });
  req.user.domains = [...new Set(domains)];
  save();
  res.json({ ok: true });
});

// add a project to my showcase
app.post('/api/profile/projects', auth, (req, res) => {
  const { title, description, link } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'Project title is required' });
  if (title.trim().length > 60) return res.status(400).json({ error: 'Title too long (max 60 chars)' });
  if (description && description.length > 300)
    return res.status(400).json({ error: 'Description too long (max 300 chars)' });
  if (link && !isHttp(link)) return res.status(400).json({ error: 'Link must start with http:// or https://' });
  if (req.user.projects.length >= 10)
    return res.status(400).json({ error: 'Max 10 projects in your showcase' });
  req.user.projects.push({
    id: crypto.randomUUID(),
    title: title.trim(),
    description: (description || '').trim(),
    link: (link || '').trim(),
  });
  save();
  res.json({ ok: true });
});

app.delete('/api/profile/projects/:id', auth, (req, res) => {
  const before = req.user.projects.length;
  req.user.projects = req.user.projects.filter((p) => p.id !== req.params.id);
  if (req.user.projects.length === before) return res.status(404).json({ error: 'Project not found' });
  save();
  res.json({ ok: true });
});

// delete my account entirely
app.delete('/api/account', auth, (req, res) => {
  const srn = req.user.srn;
  const team = teamOf(srn);
  if (team) {
    if (team.leader === srn) {
      // leader deleting account disbands the team
      db.teams = db.teams.filter((t) => t.id !== team.id);
      db.requests.forEach((r) => {
        if (r.teamId === team.id && r.status === 'pending') r.status = 'cancelled';
      });
      db.invites.forEach((i) => {
        if (i.teamId === team.id && i.status === 'pending') i.status = 'cancelled';
      });
      logEvent('team_disbanded', `Team "${team.domain}" disbanded (leader ${srn} deleted account)`);
    } else {
      team.members = team.members.filter((s) => s !== srn);
      delete team.memberNotes[srn];
      logEvent('member_left', `${req.user.name} (${srn}) left team "${team.domain}" (account deleted)`);
    }
  }
  db.requests = db.requests.filter((r) => r.srn !== srn);
  db.invites = db.invites.filter((i) => i.srn !== srn);
  db.users = db.users.filter((u) => u.srn !== srn);
  logEvent('account_deleted', `${req.user.name} (${srn}) deleted their account`);
  save();
  res.json({ ok: true });
});

// ---------- professors ----------
app.get('/api/professors', auth, (req, res) => {
  res.json(professors);
});

// ---------- student directory (all students, alphabetical, filterable) ----------
app.get('/api/students', auth, (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  const { gender, grade, domain } = req.query;
  const myTeam = teamOf(req.user.srn);
  const amLeader = myTeam && myTeam.leader === req.user.srn;
  const results = db.users
    // no search text => directory of students still LOOKING for a team; searching shows everyone
    .filter((u) => (q ? u.name.toLowerCase().includes(q) || u.srn.toLowerCase().includes(q) : !teamOf(u.srn)))
    .filter((u) => !gender || u.gender === gender)
    .filter((u) => !grade || gradeOf(u.cgpa) === grade)
    .filter((u) => !domain || (u.domains || []).includes(domain))
    .sort((a, b) => a.name.localeCompare(b.name)) // alphabetical
    .slice(0, 500)
    .map((u) => {
      const t = teamOf(u.srn);
      const out = { ...publicUser(u), team: t ? { id: t.id, domain: t.domain, branch: t.branch, full: t.members.length === TEAM_SIZE } : null };
      // if the searcher leads a team with open seats, say whether this student could join it
      if (amLeader && !t && u.srn !== req.user.srn) {
        out.eligibleForMyTeam = joinBlock(myTeam, u);
        out.invited = !!db.invites.find((i) => i.teamId === myTeam.id && i.srn === u.srn && i.status === 'pending');
      }
      // if the student is in a team, say whether the searcher could join that team
      if (t && !t.members.includes(req.user.srn)) {
        out.team.joinBlock = myTeam ? 'Already in a team' : joinBlock(t, req.user);
        out.team.requested = !!db.requests.find(
          (r) => r.teamId === t.id && r.srn === req.user.srn && r.status === 'pending'
        );
      }
      return out;
    });
  res.json(results);
});

// ---------- activity log (accounts made, joins, leaves) ----------
app.get('/api/log', auth, (req, res) => {
  res.json(db.log.slice(-200).reverse());
});

// ---------- teams ----------
app.get('/api/teams', auth, (req, res) => {
  res.json(db.teams.map((t) => teamView(t, req.user)));
});

app.post('/api/teams', auth, (req, res) => {
  const { domain } = req.body;
  if (!domain || !domain.trim()) return res.status(400).json({ error: 'Project domain is required' });
  if (domain.trim().length > 60) return res.status(400).json({ error: 'Domain name too long (max 60 chars)' });
  if (teamOf(req.user.srn)) return res.status(400).json({ error: 'You are already in a team' });
  const team = {
    id: crypto.randomUUID(),
    domain: domain.trim(),
    branch: req.user.branch, // team belongs to the leader's branch
    leader: req.user.srn,
    members: [req.user.srn],
    memberNotes: {},
    mentor: null,
  };
  db.teams.push(team);
  // creating a team cancels your pending join requests
  db.requests.forEach((r) => {
    if (r.srn === req.user.srn && r.status === 'pending') r.status = 'cancelled';
  });
  logEvent('team_created', `${req.user.name} (${req.user.srn}) created team "${team.domain}" [${team.branch}]`);
  save();
  res.json(teamView(team, req.user));
});

// each member sets their own personal GitHub link ('' clears it)
app.post('/api/profile/github', auth, (req, res) => {
  const url = (req.body.url || '').trim();
  if (url && !isHttp(url)) return res.status(400).json({ error: 'Link must start with http:// or https://' });
  req.user.github = url;
  save();
  res.json({ ok: true });
});

// leader picks / changes / removes the mentor (professorId null clears)
app.post('/api/teams/:id/mentor', auth, (req, res) => {
  const team = db.teams.find((t) => t.id === req.params.id);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  if (team.leader !== req.user.srn)
    return res.status(403).json({ error: 'Only the team leader can choose the mentor' });
  const { professorId } = req.body;
  if (professorId === null || professorId === '') {
    team.mentor = null;
  } else {
    const prof = professors.find((p) => p.id === professorId);
    if (!prof) return res.status(404).json({ error: 'Professor not found' });
    team.mentor = prof.id;
  }
  save();
  res.json({ ok: true });
});

// each member writes THEIR OWN description — nobody can edit anyone else's
app.post('/api/teams/:id/note', auth, (req, res) => {
  const team = db.teams.find((t) => t.id === req.params.id);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  if (!team.members.includes(req.user.srn))
    return res.status(403).json({ error: 'Only team members can write a description' });
  const text = (req.body.text || '').trim();
  if (text.length > 400) return res.status(400).json({ error: 'Description too long (max 400 chars)' });
  team.memberNotes[req.user.srn] = text; // keyed by the caller's own SRN
  save();
  res.json({ ok: true });
});

app.post('/api/teams/:id/join', auth, (req, res) => {
  const team = db.teams.find((t) => t.id === req.params.id);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  if (team.members.includes(req.user.srn))
    return res.status(400).json({ error: "This is your own team — you can't request to join it" });
  if (teamOf(req.user.srn)) return res.status(400).json({ error: 'You are already in a team' });
  const block = joinBlock(team, req.user);
  if (block) return res.status(400).json({ error: block });
  const dup = db.requests.find(
    (r) => r.teamId === team.id && r.srn === req.user.srn && r.status === 'pending'
  );
  if (dup) return res.status(400).json({ error: 'Request already sent' });
  // optional WhatsApp number so the leader can chat before accepting
  const wa = normWa(req.body.whatsapp);
  if (wa === null)
    return res.status(400).json({ error: 'Enter a valid WhatsApp number (10 digits, or with country code)' });
  db.requests.push({
    id: crypto.randomUUID(),
    teamId: team.id,
    srn: req.user.srn,
    status: 'pending',
    whatsapp: wa,
  });
  save();
  res.json({ ok: true });
});

// leader invites a student to their team (branch + grade + gender rules enforced)
app.post('/api/teams/:id/invite', auth, (req, res) => {
  const team = db.teams.find((t) => t.id === req.params.id);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  if (team.leader !== req.user.srn)
    return res.status(403).json({ error: 'Only the team leader can invite students' });
  const cand = userBySrn(String(req.body.srn || '').toUpperCase());
  if (!cand) return res.status(404).json({ error: 'Student not found' });
  if (cand.srn === req.user.srn) return res.status(400).json({ error: "You can't invite yourself" });
  if (teamOf(cand.srn)) return res.status(400).json({ error: 'This student is already in a team' });
  const block = joinBlock(team, cand); // same branch / grade slot / gender slot checks
  if (block) return res.status(400).json({ error: block });
  const dup = db.invites.find((i) => i.teamId === team.id && i.srn === cand.srn && i.status === 'pending');
  if (dup) return res.status(400).json({ error: 'Already invited — waiting for their reply' });
  db.invites.push({ id: crypto.randomUUID(), teamId: team.id, srn: cand.srn, status: 'pending' });
  logEvent('invite_sent', `${req.user.name} (${req.user.srn}) invited ${cand.name} (${cand.srn}) to team "${team.domain}"`);
  save();
  res.json({ ok: true });
});

// invited student accepts / rejects an invitation
app.post('/api/invites/:id', auth, (req, res) => {
  const inv = db.invites.find((x) => x.id === req.params.id);
  if (!inv || inv.status !== 'pending') return res.status(404).json({ error: 'Invitation not found' });
  if (inv.srn !== req.user.srn) return res.status(403).json({ error: 'This invitation is not for you' });

  if (req.body.action === 'reject') {
    inv.status = 'rejected';
    save();
    return res.json({ ok: true });
  }

  const team = db.teams.find((t) => t.id === inv.teamId);
  if (!team) { inv.status = 'cancelled'; save(); return res.status(400).json({ error: 'That team no longer exists' }); }
  if (teamOf(req.user.srn)) return res.status(400).json({ error: 'You are already in a team' });
  const block = joinBlock(team, req.user);
  if (block) return res.status(400).json({ error: `Cannot join: ${block}` });

  team.members.push(req.user.srn);
  inv.status = 'accepted';
  logEvent('member_joined', `${req.user.name} (${req.user.srn}) joined team "${team.domain}" (accepted invitation)${team.members.length === TEAM_SIZE ? ' — team complete' : ''}`);
  // cancel their other pending invites + join requests
  db.invites.forEach((x) => { if (x.srn === req.user.srn && x.status === 'pending') x.status = 'cancelled'; });
  db.requests.forEach((x) => { if (x.srn === req.user.srn && x.status === 'pending') x.status = 'cancelled'; });
  // if team is now full, close the remaining queue
  if (team.members.length === TEAM_SIZE) {
    db.requests.forEach((x) => { if (x.teamId === team.id && x.status === 'pending') x.status = 'rejected'; });
    db.invites.forEach((x) => { if (x.teamId === team.id && x.status === 'pending') x.status = 'cancelled'; });
  }
  save();
  res.json({ ok: true });
});

// leader removes a member; their team description goes with them
app.post('/api/teams/:id/kick', auth, (req, res) => {
  const team = db.teams.find((t) => t.id === req.params.id);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  if (team.leader !== req.user.srn)
    return res.status(403).json({ error: 'Only the team leader can remove members' });
  const srn = String(req.body.srn || '').toUpperCase();
  if (srn === team.leader)
    return res.status(400).json({ error: 'The leader cannot remove themselves — disband the team instead' });
  if (!team.members.includes(srn)) return res.status(404).json({ error: 'That student is not in your team' });
  const member = userBySrn(srn);
  team.members = team.members.filter((s) => s !== srn);
  delete team.memberNotes[srn];
  logEvent('member_removed', `${member.name} (${srn}) was removed from team "${team.domain}" by the leader`);
  save();
  res.json({ ok: true });
});

// leader accepts / rejects a request
app.post('/api/requests/:id', auth, (req, res) => {
  const { action } = req.body; // 'accept' | 'reject'
  const r = db.requests.find((x) => x.id === req.params.id);
  if (!r || r.status !== 'pending') return res.status(404).json({ error: 'Request not found' });
  const team = db.teams.find((t) => t.id === r.teamId);
  if (!team || team.leader !== req.user.srn)
    return res.status(403).json({ error: 'Only the team leader can do this' });

  if (action === 'reject') {
    r.status = 'rejected';
    save();
    return res.json({ ok: true });
  }

  const candidate = userBySrn(r.srn);
  if (teamOf(candidate.srn)) {
    r.status = 'cancelled';
    save();
    return res.status(400).json({ error: 'This student already joined another team' });
  }
  const block = joinBlock(team, candidate);
  if (block) return res.status(400).json({ error: `Cannot accept: ${block}` });

  team.members.push(candidate.srn);
  r.status = 'accepted';
  logEvent('member_joined', `${candidate.name} (${candidate.srn}) joined team "${team.domain}"${team.members.length === TEAM_SIZE ? ' — team complete' : ''}`);
  // cancel the candidate's other pending requests and invites
  db.requests.forEach((x) => {
    if (x.srn === candidate.srn && x.status === 'pending') x.status = 'cancelled';
  });
  db.invites.forEach((x) => {
    if (x.srn === candidate.srn && x.status === 'pending') x.status = 'cancelled';
  });
  // if team is now full, reject everyone else who was waiting
  if (team.members.length === TEAM_SIZE) {
    db.requests.forEach((x) => {
      if (x.teamId === team.id && x.status === 'pending') x.status = 'rejected';
    });
    db.invites.forEach((x) => {
      if (x.teamId === team.id && x.status === 'pending') x.status = 'cancelled';
    });
  }
  save();
  res.json({ ok: true });
});

// member leaves; leader leaving disbands the team
app.post('/api/teams/:id/leave', auth, (req, res) => {
  const team = db.teams.find((t) => t.id === req.params.id);
  if (!team || !team.members.includes(req.user.srn))
    return res.status(400).json({ error: 'You are not in this team' });
  if (team.leader === req.user.srn) {
    db.teams = db.teams.filter((t) => t.id !== team.id);
    db.requests.forEach((r) => {
      if (r.teamId === team.id && r.status === 'pending') r.status = 'cancelled';
    });
    db.invites.forEach((i) => {
      if (i.teamId === team.id && i.status === 'pending') i.status = 'cancelled';
    });
    logEvent('team_disbanded', `${req.user.name} (${req.user.srn}) disbanded team "${team.domain}"`);
  } else {
    team.members = team.members.filter((s) => s !== req.user.srn);
    delete team.memberNotes[req.user.srn];
    logEvent('member_left', `${req.user.name} (${req.user.srn}) left team "${team.domain}"`);
  }
  save();
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Team Finder running on http://localhost:${PORT}`));
