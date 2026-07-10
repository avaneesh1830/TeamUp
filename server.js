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
  if (u.bio === undefined) u.bio = ''; // personal "what I've worked on"
  if (u.email === undefined) u.email = '';
  if (!u.pwChanges) u.pwChanges = []; // timestamps, for the 3-changes-per-day limit
  // numbers are now stored as plain 10 digits (no country code)
  if (u.whatsapp && u.whatsapp.length === 12 && u.whatsapp.startsWith('91')) u.whatsapp = u.whatsapp.slice(2);
});
(db.requests || []).forEach((r) => {
  if (r.whatsapp && r.whatsapp.length === 12 && r.whatsapp.startsWith('91')) r.whatsapp = r.whatsapp.slice(2);
});
db.teams.forEach((t) => {
  if (t.mentor === undefined) t.mentor = null;
  if (t.description === undefined) t.description = '';
  // teams now have multiple domains
  if (t.domain && !t.domains) { t.domains = [t.domain]; delete t.domain; }
  if (!t.domains) t.domains = [];
  // old per-team member notes become the member's personal bio
  if (t.memberNotes) {
    for (const [srn, note] of Object.entries(t.memberNotes)) {
      const u = db.users.find((x) => x.srn === srn);
      if (u && !u.bio && note) u.bio = note;
    }
    delete t.memberNotes;
  }
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

// ---------- mentors ----------
// official mentor list (from the shared faculty-domains sheet)
const MENTOR_FILE = path.join(__dirname, 'mentors.json');
let mentors = [];
if (fs.existsSync(MENTOR_FILE)) {
  mentors = JSON.parse(fs.readFileSync(MENTOR_FILE, 'utf8'));
}

// ---------- helpers ----------
const TEAM_SIZE = 4;
const BRANCHES = ['CSE', 'AIML', 'ECE'];
// the official domain list — team domains AND profile interests must come from here
const DOMAINS = [
  'AI / Machine Learning',
  'Deep Learning / Computer Vision',
  'NLP / LLMs & Chatbots',
  'Data Science & Analytics',
  'Big Data',
  'Web Development',
  'Mobile App Development',
  'Game Development',
  'Cybersecurity',
  'Blockchain / Web3',
  'Cloud Computing / DevOps',
  'IoT / Embedded Systems',
  'Robotics & Automation',
  'AR / VR',
  'Drones / UAV',
  'VLSI / Chip Design',
  'Networking / 5G',
  'Signal & Image Processing',
  'Renewable Energy / EV Tech',
  'Quantum Computing',
  'FinTech',
  'HealthTech',
  'EdTech',
];
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const gradeOf = (cgpa) => (cgpa >= 8 ? 'A' : cgpa >= 7 ? 'B' : 'C');
const teamOf = (srn) => db.teams.find((t) => t.members.includes(srn));
const userBySrn = (srn) => db.users.find((u) => u.srn === srn);
const isHttp = (s) => /^https?:\/\/\S+$/i.test(s);
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

// ---------- password reset via email OTP ----------
// real mail goes out when SMTP_USER/SMTP_PASS are set (e.g. a Gmail app password);
// otherwise the OTP is printed to the server console (dev mode)
let mailer = null;
if (process.env.SMTP_USER && process.env.SMTP_PASS) {
  const nodemailer = require('nodemailer');
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}
async function sendOtpMail(to, code) {
  if (!mailer) {
    console.log(`[DEV MODE — no SMTP configured] OTP for ${to}: ${code}`);
    return;
  }
  await mailer.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject: 'TeamUp — your password reset OTP',
    text: `Your TeamUp password reset OTP is: ${code}\n\nIt expires in 10 minutes. If you didn't request this, just ignore this email.`,
  });
}
const otps = {}; // srn -> { code, expires, tries }  (password resets)
const pendingRegs = {}; // srn -> { user, code, expires, tries }  (registrations awaiting email OTP)
const maskEmail = (e) => e.replace(/^(.).*(@.*)$/, '$1•••$2');

// password changes (any method) limited to 3 per day
function pwChangeAllowed(u) {
  const DAY = 24 * 60 * 60 * 1000;
  u.pwChanges = (u.pwChanges || []).filter((t) => Date.now() - t < DAY);
  return u.pwChanges.length < 3;
}
function setPassword(u, password) {
  u.salt = crypto.randomBytes(8).toString('hex');
  u.pwHash = hashPw(password, u.salt);
  u.token = crypto.randomUUID(); // log out existing sessions
  u.pwChanges.push(Date.now());
}

// normalize a WhatsApp number: '' if empty, null if invalid, else exactly 10 digits
function normWa(x) {
  let wa = String(x || '').replace(/\D/g, '');
  if (!wa) return '';
  if (wa.length === 12 && wa.startsWith('91')) wa = wa.slice(2); // tolerate pasted +91 numbers
  if (wa.length !== 10) return null;
  return wa;
}

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const user = token && db.users.find((u) => u.token === token);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  req.user = user;
  next();
}

// the ONLY grade combinations a complete team of 4 may have
const ALLOWED_GRADE_COMBOS = ['AABC', 'ABBC', 'ABCC', 'AACC', 'BBCC'].map((s) => s.split(''));

// can this (partial) set of grades still grow into one of the allowed combos?
function fitsSomeCombo(grades) {
  return ALLOWED_GRADE_COMBOS.some((combo) => {
    const left = [...combo];
    return grades.every((g) => {
      const i = left.indexOf(g);
      if (i < 0) return false;
      left.splice(i, 1);
      return true;
    });
  });
}

// Which slots are still open on a team?
function slotInfo(team) {
  const members = team.members.map(userBySrn);
  const remaining = TEAM_SIZE - members.length;
  const grades = members.map((m) => gradeOf(m.cgpa));
  const boys = members.filter((m) => m.gender === 'M').length;
  const girls = members.length - boys;
  // a grade slot is open if adding it can still lead to an allowed combination
  const openGrades = remaining === 0 ? [] : ['A', 'B', 'C'].filter((g) => fitsSomeCombo([...grades, g]));
  return {
    remaining,
    boys,
    girls,
    openGrades,
    // mixed-gender teams are preferred but NOT required — any gender can take an open seat
    boysOpen: remaining > 0,
    girlsOpen: remaining > 0,
  };
}

// CSE and AIML are computing branches that may combine in one team
const branchesCombine = (a, b) => a === b || (['CSE', 'AIML'].includes(a) && ['CSE', 'AIML'].includes(b));

// null if user can join, otherwise a reason string
function joinBlock(team, user) {
  if (!branchesCombine(user.branch, team.branch))
    return team.branch === 'ECE'
      ? 'Only ECE students can join this team'
      : 'Only CSE / AIML students can join this team';
  const s = slotInfo(team);
  if (s.remaining === 0) return 'Team is full';
  const g = gradeOf(user.cgpa);
  if (!s.openGrades.includes(g))
    return `No ${g}-grade slot — it would break the allowed grade combinations`;
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
  bio: u.bio || '',
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
    domains: team.domains,
    description: team.description || '',
    branch: team.branch,
    leader: team.leader,
    mentor: team.mentor ? mentors.find((m) => m.id === team.mentor) || null : null,
    members: team.members.map((srn) => publicUser(userBySrn(srn))),
    slots: s,
    requested: !!myReq,
    joinBlock: viewer ? (teamOf(viewer.srn) ? 'You are already in a team' : joinBlock(team, viewer)) : null,
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
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!isEmail(email)) return res.status(400).json({ error: 'Enter a valid email — you need it to reset your password' });
  const wa = normWa(req.body.whatsapp);
  if (wa === null) return res.status(400).json({ error: 'Enter a valid 10-digit WhatsApp number' });
  const salt = crypto.randomBytes(8).toString('hex');
  const user = {
    srn: id,
    name: name.trim(),
    gender,
    branch,
    cgpa: c,
    email,
    projects: [],
    github: '',
    domains: [],
    whatsapp: wa,
    pwChanges: [],
    salt,
    pwHash: hashPw(password, salt),
    token: crypto.randomUUID(),
  };
  // account is only created after the email OTP is verified
  const code = '123456'; // TEMP: fixed OTP until the real email API (Postmark/SES) is wired up
  pendingRegs[id] = { user, code, expires: Date.now() + 10 * 60 * 1000, tries: 0 };
  sendOtpMail(email, code).catch((e) => console.error('OTP mail failed:', e.message));
  res.json({ otp: true, email: maskEmail(email) });
});

// registration step 2 — verify the OTP, then create the account
app.post('/api/register/verify', (req, res) => {
  const srn = String(req.body.srn || '').trim().toUpperCase();
  const rec = pendingRegs[srn];
  if (!rec) return res.status(400).json({ error: 'Start the registration again' });
  if (Date.now() > rec.expires) { delete pendingRegs[srn]; return res.status(400).json({ error: 'OTP expired — register again' }); }
  if (rec.tries >= 5) { delete pendingRegs[srn]; return res.status(400).json({ error: 'Too many wrong attempts — register again' }); }
  if (String(req.body.otp || '').trim() !== rec.code) {
    rec.tries++;
    return res.status(400).json({ error: 'Wrong OTP' });
  }
  if (userBySrn(srn)) { delete pendingRegs[srn]; return res.status(400).json({ error: 'This SRN is already registered' }); }
  db.users.push(rec.user);
  delete pendingRegs[srn];
  logEvent('account_created', `${rec.user.name} (${rec.user.srn}, ${rec.user.branch}) registered (email verified)`);
  save();
  res.json({ token: rec.user.token });
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

// forgot password: step 1 — send an OTP to the account's email.
// Response is ALWAYS the same generic OK so nobody can probe which accounts exist
// (existence is only confirmed once the OTP from the email is verified).
app.post('/api/forgot', (req, res) => {
  const user = userBySrn(String(req.body.srn || '').trim().toUpperCase());
  if (user && user.email && pwChangeAllowed(user)) {
    const code = '123456'; // TEMP: fixed OTP until the real email API (Postmark/SES) is wired up
    otps[user.srn] = { code, expires: Date.now() + 10 * 60 * 1000, tries: 0 };
    sendOtpMail(user.email, code).catch((e) => console.error('OTP mail failed:', e.message));
    logEvent('password_otp_sent', `Password reset OTP sent for ${user.srn}`);
  }
  res.json({ ok: true });
});

// forgot password: step 2 — verify the OTP and set a new password
app.post('/api/reset', (req, res) => {
  const user = userBySrn(String(req.body.srn || '').trim().toUpperCase());
  const rec = user && otps[user.srn];
  if (!rec) return res.status(400).json({ error: 'Request an OTP first' });
  if (Date.now() > rec.expires) { delete otps[user.srn]; return res.status(400).json({ error: 'OTP expired — request a new one' }); }
  if (rec.tries >= 5) { delete otps[user.srn]; return res.status(400).json({ error: 'Too many wrong attempts — request a new OTP' }); }
  if (String(req.body.otp || '').trim() !== rec.code) {
    rec.tries++;
    return res.status(400).json({ error: 'Wrong OTP' });
  }
  const { password } = req.body;
  if (!password || password.length < 4)
    return res.status(400).json({ error: 'New password must be at least 4 characters' });
  if (!pwChangeAllowed(user))
    return res.status(429).json({ error: 'Password change limit reached (3 per day) — try again tomorrow' });
  setPassword(user, password);
  delete otps[user.srn];
  logEvent('password_reset', `${user.name} (${user.srn}) reset their password via OTP`);
  save();
  res.json({ ok: true });
});

// ---------- me / profile ----------
app.get('/api/me', auth, (req, res) => {
  const me = req.user;
  const team = teamOf(me.srn);
  // any team member can see (and act on) incoming requests
  const incoming = team
    ? db.requests
        .filter((r) => r.teamId === team.id && r.status === 'pending')
        .map((r) => {
          const candTeam = teamOf(r.srn);
          return {
            id: r.id,
            user: publicUser(userBySrn(r.srn)),
            whatsapp: r.whatsapp || '',
            // heads-up for the team: this requester has since joined another team
            candidateTeam: candTeam ? candTeam.domains.join(' / ') : null,
          };
        })
    : [];
  const outgoing = db.requests
    .filter((r) => r.srn === me.srn)
    .map((r) => {
      const t = db.teams.find((x) => x.id === r.teamId);
      return { id: r.id, teamId: r.teamId, teamDomain: t ? t.domains.join(' / ') : '(deleted team)', status: r.status };
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
        teamDomain: t ? t.domains.join(' / ') : '(disbanded team)',
        teamBranch: t ? t.branch : '',
        leaderName: leader ? leader.name : '',
      };
    });
  // invitations my team has sent (visible to every member)
  const sentInvites = team
    ? db.invites
        .filter((i) => i.teamId === team.id)
        .map((i) => {
          const u = userBySrn(i.srn);
          return { id: i.id, srn: i.srn, name: u ? u.name : i.srn, status: i.status };
        })
    : [];
  res.json({
    user: { ...publicUser(me), cgpa: me.cgpa, email: me.email || '' },
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
    if (!branchesCombine(branch, team.branch))
      return res.status(400).json({ error: `You are in a ${team.branch} team — leave it before changing to an incompatible branch` });
    const sim = team.members.map((s) =>
      s === req.user.srn ? { cgpa: c } : userBySrn(s)
    );
    const grades = sim.map((m) => gradeOf(m.cgpa));
    if (!fitsSomeCombo(grades))
      return res.status(400).json({
        error: "This change would break your team's allowed grade combination (AABC, ABBC, ABCC, AACC or BBCC)",
      });
  }

  const wa = normWa(req.body.whatsapp);
  if (wa === null) return res.status(400).json({ error: 'Enter a valid 10-digit WhatsApp number' });
  const email = String(req.body.email || '').trim().toLowerCase();
  if (email && !isEmail(email)) return res.status(400).json({ error: 'Enter a valid email' });
  if (password && !pwChangeAllowed(req.user))
    return res.status(429).json({ error: 'Password change limit reached (3 per day) — try again tomorrow' });

  req.user.name = name.trim();
  req.user.gender = gender;
  req.user.branch = branch;
  req.user.cgpa = c;
  req.user.whatsapp = wa;
  if (email) req.user.email = email;
  if (password) {
    const current = req.user.token;
    setPassword(req.user, password);
    req.user.token = current; // changing your own password shouldn't log this session out
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
      logEvent('team_disbanded', `Team "${team.domains.join(', ')}" disbanded (leader ${srn} deleted account)`);
    } else {
      team.members = team.members.filter((s) => s !== srn);
      logEvent('member_left', `${req.user.name} (${srn}) left team "${team.domains.join(', ')}" (account deleted)`);
    }
  }
  db.requests = db.requests.filter((r) => r.srn !== srn);
  db.invites = db.invites.filter((i) => i.srn !== srn);
  db.users = db.users.filter((u) => u.srn !== srn);
  logEvent('account_deleted', `${req.user.name} (${srn}) deleted their account`);
  save();
  res.json({ ok: true });
});

// mentor directory from the official faculty-domains sheet
app.get('/api/mentors', auth, (req, res) => {
  res.json(mentors);
});

// ---------- student directory (all students, alphabetical, filterable) ----------
app.get('/api/students', auth, (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  const { gender, grade, domain, branch, eligible } = req.query;
  const myTeam = teamOf(req.user.srn);
  // any member of a team with an open seat gets invite powers + the eligibility filter
  const canInvite = myTeam && slotInfo(myTeam).remaining > 0;
  const results = db.users
    // no search text => directory of students still LOOKING for a team (plus yourself); searching shows everyone
    .filter((u) =>
      q ? u.name.toLowerCase().includes(q) || u.srn.toLowerCase().includes(q) : !teamOf(u.srn) || u.srn === req.user.srn
    )
    .filter((u) => !branch || u.branch === branch)
    .filter((u) => !gender || u.gender === gender)
    .filter((u) => !grade || gradeOf(u.cgpa) === grade)
    .filter((u) => !domain || (u.domains || []).includes(domain))
    // "eligible for my team": passes every rule — branch, grade slot, gender slot
    .filter(
      (u) =>
        eligible !== '1' ||
        (myTeam && u.srn !== req.user.srn && !teamOf(u.srn) && joinBlock(myTeam, u) === null)
    )
    .sort((a, b) => a.name.localeCompare(b.name)) // alphabetical
    .slice(0, 500)
    .map((u) => {
      const t = teamOf(u.srn);
      const out = { ...publicUser(u), team: t ? { id: t.id, domain: t.domains.join(' / '), branch: t.branch, full: t.members.length === TEAM_SIZE } : null };
      // if the searcher's team has open seats, say whether this student could join it
      if (canInvite && !t && u.srn !== req.user.srn) {
        out.eligibleForMyTeam = joinBlock(myTeam, u);
        out.invited = !!db.invites.find((i) => i.teamId === myTeam.id && i.srn === u.srn && i.status === 'pending');
      }
      // if the student is in a team, say whether the searcher could join that team
      if (t && !t.members.includes(req.user.srn)) {
        out.team.joinBlock = myTeam ? 'You are already in a team' : joinBlock(t, req.user);
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
  // one or more domains, all from the official list — no custom team domains
  const domains = [...new Set(req.body.domains || [])];
  if (!Array.isArray(domains) || domains.length === 0)
    return res.status(400).json({ error: 'Pick at least one project domain from the list' });
  if (domains.length > 3) return res.status(400).json({ error: 'Pick at most 3 domains' });
  const invalid = domains.filter((d) => !DOMAINS.includes(d));
  if (invalid.length) return res.status(400).json({ error: `Not in the domain list: ${invalid.join(', ')}` });
  if (teamOf(req.user.srn)) return res.status(400).json({ error: 'You are already in a team' });
  const team = {
    id: crypto.randomUUID(),
    domains,
    description: '',
    branch: req.user.branch, // team belongs to the leader's branch
    leader: req.user.srn,
    members: [req.user.srn],
    mentor: null,
  };
  db.teams.push(team);
  logEvent('team_created', `${req.user.name} (${req.user.srn}) created team "${domains.join(', ')}" [${team.branch}]`);
  save();
  res.json(teamView(team, req.user));
});

// team description — leader only
app.post('/api/teams/:id/description', auth, (req, res) => {
  const team = db.teams.find((t) => t.id === req.params.id);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  if (team.leader !== req.user.srn)
    return res.status(403).json({ error: 'Only the team leader can write the team description' });
  const text = (req.body.text || '').trim();
  if (text.length > 500) return res.status(400).json({ error: 'Description too long (max 500 chars)' });
  team.description = text;
  save();
  res.json({ ok: true });
});

// my personal bio + GitHub — lives on the profile, shown when people open it
app.post('/api/profile/about', auth, (req, res) => {
  const bio = (req.body.bio || '').trim();
  if (bio.length > 400) return res.status(400).json({ error: 'Bio too long (max 400 chars)' });
  const url = (req.body.github || '').trim();
  if (url && !isHttp(url)) return res.status(400).json({ error: 'Link must start with http:// or https://' });
  req.user.bio = bio;
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
    const m = mentors.find((x) => x.id === professorId);
    if (!m) return res.status(404).json({ error: 'Mentor not found' });
    team.mentor = m.id;
  }
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
    return res.status(400).json({ error: 'Enter a valid 10-digit WhatsApp number' });
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

// any team member invites a student to their team (branch + grade + gender rules enforced)
app.post('/api/teams/:id/invite', auth, (req, res) => {
  const team = db.teams.find((t) => t.id === req.params.id);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  if (!team.members.includes(req.user.srn))
    return res.status(403).json({ error: 'Only members of this team can invite students' });
  const cand = userBySrn(String(req.body.srn || '').toUpperCase());
  if (!cand) return res.status(404).json({ error: 'Student not found' });
  if (cand.srn === req.user.srn) return res.status(400).json({ error: "You can't invite yourself" });
  if (teamOf(cand.srn)) return res.status(400).json({ error: 'This student is already in a team' });
  const block = joinBlock(team, cand); // same branch / grade slot / gender slot checks
  if (block) return res.status(400).json({ error: block });
  const dup = db.invites.find((i) => i.teamId === team.id && i.srn === cand.srn && i.status === 'pending');
  if (dup) return res.status(400).json({ error: 'Already invited — waiting for their reply' });
  db.invites.push({ id: crypto.randomUUID(), teamId: team.id, srn: cand.srn, status: 'pending' });
  logEvent('invite_sent', `${req.user.name} (${req.user.srn}) invited ${cand.name} (${cand.srn}) to team "${team.domains.join(', ')}"`);
  save();
  res.json({ ok: true });
});

// invited student accepts / rejects · the inviting team can cancel
app.post('/api/invites/:id', auth, (req, res) => {
  const inv = db.invites.find((x) => x.id === req.params.id);
  if (!inv || inv.status !== 'pending') return res.status(404).json({ error: 'Invitation not found' });

  // any member of the inviting team can withdraw the invite
  if (req.body.action === 'cancel') {
    const t = db.teams.find((x) => x.id === inv.teamId);
    if (!t || !t.members.includes(req.user.srn))
      return res.status(403).json({ error: 'Only the inviting team can cancel this' });
    inv.status = 'cancelled';
    save();
    return res.json({ ok: true });
  }

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
  logEvent('member_joined', `${req.user.name} (${req.user.srn}) joined team "${team.domains.join(', ')}" (accepted invitation)${team.members.length === TEAM_SIZE ? ' — team complete' : ''}`);
  // NOTE: their other pending invites/requests stay alive on purpose
  // if team is now full, close this team's remaining queue
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
  logEvent('member_removed', `${member.name} (${srn}) was removed from team "${team.domains.join(', ')}" by the leader`);
  save();
  res.json({ ok: true });
});

// accept / reject (any team member) · cancel (the requester themselves)
app.post('/api/requests/:id', auth, (req, res) => {
  const { action } = req.body; // 'accept' | 'reject' | 'cancel'
  const r = db.requests.find((x) => x.id === req.params.id);
  if (!r || r.status !== 'pending') return res.status(404).json({ error: 'Request not found' });

  // a student can cancel their own pending request
  if (action === 'cancel') {
    if (r.srn !== req.user.srn) return res.status(403).json({ error: 'Only the requester can cancel this' });
    r.status = 'cancelled';
    save();
    return res.json({ ok: true });
  }

  const team = db.teams.find((t) => t.id === r.teamId);
  if (!team || !team.members.includes(req.user.srn))
    return res.status(403).json({ error: 'Only members of this team can do this' });

  if (action === 'reject') {
    r.status = 'rejected';
    save();
    return res.json({ ok: true });
  }

  const candidate = userBySrn(r.srn);
  // keep the request pending "just in case" they leave that team later
  if (teamOf(candidate.srn))
    return res.status(400).json({ error: 'This student is currently in another team — the request stays pending in case they leave' });
  const block = joinBlock(team, candidate);
  if (block) return res.status(400).json({ error: `Cannot accept: ${block}` });

  team.members.push(candidate.srn);
  r.status = 'accepted';
  logEvent('member_joined', `${candidate.name} (${candidate.srn}) joined team "${team.domains.join(', ')}" (accepted by ${req.user.srn})${team.members.length === TEAM_SIZE ? ' — team complete' : ''}`);
  // NOTE: their other pending requests/invites are intentionally kept alive
  // if team is now full, close this team's own waiting queue
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
    logEvent('team_disbanded', `${req.user.name} (${req.user.srn}) disbanded team "${team.domains.join(', ')}"`);
  } else {
    team.members = team.members.filter((s) => s !== req.user.srn);
    logEvent('member_left', `${req.user.name} (${req.user.srn}) left team "${team.domains.join(', ')}"`);
  }
  save();
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Team Finder running on http://localhost:${PORT}`));
