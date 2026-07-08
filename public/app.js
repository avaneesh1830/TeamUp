// ---------- constants ----------
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
const BRANCHES = ['CSE', 'AIML', 'ECE'];

// ---------- state & api ----------
let token = localStorage.getItem('token');
let me = null; // { user, team, incoming, outgoing }
let teams = [];
let professors = [];
let activeTab = 'browse'; // browse | students | team | requests | profile
let filters = { branch: 'ALL', domain: 'ALL', grade: 'ALL', gender: 'ALL' };
let mentorQuery = '';
let studentQuery = '';
let sFilters = { gender: 'ALL', grade: 'ALL', domain: 'ALL', eligible: false }; // students directory filters

async function api(path, method = 'GET', body) {
  const res = await fetch('/api' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { logout(); throw new Error('Session expired, please log in again'); }
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initials = (name) => name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

// ---------- toast ----------
let toastTimer;
function toast(msg, type = 'err') {
  const t = $('toast');
  t.textContent = msg;
  t.className = `show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), 3500);
}

// ---------- auth view ----------
function showAuth() {
  $('authView').classList.remove('hidden');
  $('mainView').classList.add('hidden');
}

$('tabLogin').onclick = () => switchAuthTab(true);
$('tabRegister').onclick = () => switchAuthTab(false);
function switchAuthTab(login) {
  $('tabLogin').classList.toggle('active', login);
  $('tabRegister').classList.toggle('active', !login);
  $('loginForm').classList.toggle('hidden', !login);
  $('registerForm').classList.toggle('hidden', login);
  $('authError').textContent = '';
}

$('loginForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const r = await api('/login', 'POST', { srn: $('loginSrn').value, password: $('loginPw').value });
    setToken(r.token);
  } catch (err) { $('authError').textContent = err.message; }
};

$('registerForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const r = await api('/register', 'POST', {
      name: $('regName').value,
      srn: $('regSrn').value,
      branch: $('regBranch').value,
      gender: $('regGender').value,
      cgpa: $('regCgpa').value,
      whatsapp: $('regWa').value,
      password: $('regPw').value,
    });
    setToken(r.token);
  } catch (err) { $('authError').textContent = err.message; }
};

function setToken(t) {
  token = t;
  localStorage.setItem('token', t);
  activeTab = 'browse';
  refresh();
}

function logout() {
  token = null;
  me = null;
  localStorage.removeItem('token');
  showAuth();
}
$('logoutBtn').onclick = logout;

// ---------- main tab nav ----------
document.querySelectorAll('.mtab').forEach((b) => {
  b.onclick = () => {
    activeTab = b.dataset.tab;
    render();
  };
});

// ---------- rendering helpers ----------
const gradeBadge = (g) => `<span class="badge ${g}">${g}</span>`;
const genderLabel = (g) => (g === 'M' ? 'Male' : 'Female');

const profPhoto = (p, cls = '') =>
  p.photo
    ? `<img class="pphoto ${cls}" src="${esc(p.photo)}" alt="${esc(p.name)}" />`
    : `<div class="pphoto init ${cls}">${esc(initials(p.name))}</div>`;

function projectItem(p, deletable = false) {
  return `<div class="project-item">
    ${deletable ? `<button class="btn small danger pdel" data-delproj="${p.id}" type="button">✕</button>` : ''}
    <div class="ptitle">${esc(p.title)}</div>
    ${p.description ? `<div class="pdesc">${esc(p.description)}</div>` : ''}
    ${p.link ? `<a href="${esc(p.link)}" target="_blank" rel="noopener">🔗 ${esc(p.link)}</a>` : ''}
  </div>`;
}

// member row with expandable project showcase + their own team note
function memberRow(m, leaderSrn, note, extra = '') {
  const pid = 'proj_' + m.srn.replace(/[^A-Za-z0-9]/g, '');
  return `<div class="member-block">
    <div class="member">
      ${m.srn === leaderSrn ? '<span class="crown" title="Team leader">👑</span>' : ''}
      <strong>${esc(m.name)}</strong>
      <span class="srn">${esc(m.srn)}</span>
      ${gradeBadge(m.grade)}
      <span class="badge gender">${genderLabel(m.gender)}</span>
      ${m.github ? `<a class="gh-chip sm" href="${esc(m.github)}" target="_blank" rel="noopener">🐙 GitHub</a>` : ''}
      ${m.projects.length ? `<button class="linklike" data-toggle="${pid}" type="button">📂 ${m.projects.length} project${m.projects.length === 1 ? '' : 's'}</button>` : ''}
      ${extra}
    </div>
    ${note ? `<div class="member-note"><span class="who">What ${esc(m.name.split(' ')[0])} has worked on</span>${esc(note)}</div>` : ''}
    ${m.projects.length ? `<div id="${pid}" class="projects hidden">${m.projects.map((p) => projectItem(p)).join('')}</div>` : ''}
  </div>`;
}

function slotRow(s) {
  const gradeBadges = ['A', 'B', 'C']
    .map((g) => {
      const open = s.openGrades.includes(g);
      const needed = s.missing.includes(g);
      return `<span class="badge ${open ? 'open' : 'closed'}" title="${open ? 'slot available' : 'not available'}">${g}${needed && open ? ' · needed' : ''}</span>`;
    })
    .join(' ');
  return `
    <div class="slot-row"><span class="lbl">Grade slots:</span> ${s.remaining === 0 ? '<span class="badge closed">team full</span>' : gradeBadges}</div>
    <div class="slot-row"><span class="lbl">Gender slots:</span>
      <span class="badge ${s.boysOpen ? 'open' : 'closed'}">Male ${s.boys}/3</span>
      <span class="badge ${s.girlsOpen ? 'open' : 'closed'}">Female ${s.girls}/3</span>
      <span class="lbl">· ${s.remaining} seat${s.remaining === 1 ? '' : 's'} left</span>
    </div>`;
}

function mentorLine(t) {
  if (t.mentor)
    return `<div class="mentor-line">${profPhoto(t.mentor, 'sm')}
      <span><span class="lbl">Mentor:</span> <strong>${esc(t.mentor.name)}</strong>
      <span class="mentor-sub">· ${esc(t.mentor.title)}, ${esc(t.mentor.dept)}</span></span></div>`;
  return `<div class="mentor-line"><span class="lbl">Mentor:</span> <span class="mentor-sub">not chosen yet</span></div>`;
}

function teamCardHead(t, right = '') {
  return `<div class="team-head">
    <div>
      <div class="domain-title">${esc(t.domain)}</div>
      <div class="team-meta">
        <span class="badge branch">${esc(t.branch)}</span>
        <span class="count">${t.members.length}/4 members${t.members.length === 4 ? ' · ✅ complete' : ''}</span>
      </div>
    </div>
    ${right}
  </div>`;
}

// ---------- main render ----------
function render() {
  $('authView').classList.add('hidden');
  $('mainView').classList.remove('hidden');
  $('meName').textContent = me.user.name;
  $('meSub').textContent = `${me.user.srn} · ${me.user.branch}`;
  $('meAvatar').textContent = initials(me.user.name);
  $('meGrade').textContent = me.user.grade + ' grade';
  $('meGrade').className = 'badge ' + me.user.grade;

  document.querySelectorAll('.mtab').forEach((b) => b.classList.toggle('active', b.dataset.tab === activeTab));
  const badge = $('reqBadge');
  const actionable = me.incoming.length + me.invites.filter((i) => i.status === 'pending').length;
  if (actionable > 0) {
    badge.textContent = actionable;
    badge.classList.remove('hidden');
  } else badge.classList.add('hidden');

  const views = { browse: browseHtml, students: studentsHtml, team: myTeamTabHtml, requests: requestsHtml, profile: profileHtml };
  $('content').innerHTML = views[activeTab]();
  bindActions();
  if (activeTab === 'students') searchStudents(); // directory loads immediately
}

// ---------- tab: browse teams ----------
function browseHtml() {
  const chips = ['ALL', ...BRANCHES]
    .map((b) => `<button class="chip ${filters.branch === b ? 'active' : ''}" data-filter="${b}" type="button">${b === 'ALL' ? 'All branches' : b}</button>`)
    .join('');

  // domain options come from the teams that actually exist
  const domainOpts = [...new Set(teams.map((t) => t.domain))].sort();
  const anyFilter = filters.branch !== 'ALL' || filters.domain !== 'ALL' || filters.grade !== 'ALL' || filters.gender !== 'ALL';

  const visible = teams.filter(
    (t) =>
      (filters.branch === 'ALL' || t.branch === filters.branch) &&
      (filters.domain === 'ALL' || t.domain === filters.domain) &&
      (filters.grade === 'ALL' || t.slots.openGrades.includes(filters.grade)) &&
      (filters.gender === 'ALL' || (filters.gender === 'M' ? t.slots.boysOpen : t.slots.girlsOpen))
  );

  let html = `<div class="section-head fade-up">
    <div><h2>Browse Teams</h2><p>Teams currently looking for members</p></div>
    <div class="chips">${chips}</div>
  </div>

  <div class="card filter-bar fade-up">
    <span class="lbl">Filters</span>
    <select id="fDomain">
      <option value="ALL">All domains</option>
      ${domainOpts.map((d) => `<option value="${esc(d)}" ${filters.domain === d ? 'selected' : ''}>${esc(d)}</option>`).join('')}
    </select>
    <select id="fGrade">
      <option value="ALL">Any grade slot</option>
      ${['A', 'B', 'C'].map((g) => `<option value="${g}" ${filters.grade === g ? 'selected' : ''}>${g}-grade slot open</option>`).join('')}
    </select>
    <select id="fGender">
      <option value="ALL">Any gender slot</option>
      <option value="M" ${filters.gender === 'M' ? 'selected' : ''}>Male can join</option>
      <option value="F" ${filters.gender === 'F' ? 'selected' : ''}>Female can join</option>
    </select>
    ${anyFilter ? `<button id="clearFilters" class="btn small ghost" type="button">✕ Clear</button>` : ''}
    <span class="count">${visible.length} of ${teams.length} team${teams.length === 1 ? '' : 's'}</span>
  </div>`;

  if (visible.length === 0) {
    html += `<div class="card"><div class="empty"><span class="big">🧭</span>${
      teams.length === 0
        ? 'No teams here yet.<br/>Head to <strong>My Team</strong> and create the first one!'
        : 'No team matches these filters.<br/>Try clearing some of them.'
    }</div></div>`;
    return html;
  }
  const sorted = [...visible].sort((a, b) => (b.slots.remaining > 0) - (a.slots.remaining > 0));
  return (
    html +
    `<div class="team-grid">` +
    sorted
      .map((t, i) => {
        const isMyTeam = me.team && me.team.id === t.id;
        const joinable = !isMyTeam && !t.joinBlock && !t.requested;
        return `<div class="card hoverable" style="animation-delay:${Math.min(i * 60, 400)}ms">
        ${teamCardHead(
          t,
          isMyTeam
            ? `<span class="badge branch">⭐ Your team</span>`
            : `<button class="btn small primary" data-join="${t.id}" ${joinable ? '' : 'disabled'} type="button">
            ${t.requested ? 'Request sent ✓' : 'Request to join'}
          </button>`
        )}
        ${mentorLine(t)}
        ${t.members.map((m) => memberRow(m, t.leader, t.memberNotes[m.srn])).join('')}
        ${slotRow(t.slots)}
        ${!isMyTeam && t.joinBlock && !t.requested ? `<p class="join-note">⚠️ ${esc(t.joinBlock)}</p>` : ''}
      </div>`;
      })
      .join('') +
    `</div>`
  );
}

// ---------- tab: students (full directory, alphabetical) ----------
function studentsHtml() {
  return `<div class="section-head fade-up">
    <div><h2>Students</h2><p>Students still looking for a team, A→Z — search by name to find anyone (even in teams)</p></div>
  </div>
  <div class="card filter-bar fade-up">
    <span class="lbl">Filters</span>
    <select id="sfGender">
      <option value="ALL">Any gender</option>
      <option value="M" ${sFilters.gender === 'M' ? 'selected' : ''}>Male</option>
      <option value="F" ${sFilters.gender === 'F' ? 'selected' : ''}>Female</option>
    </select>
    <select id="sfGrade">
      <option value="ALL">Any grade</option>
      ${['A', 'B', 'C'].map((g) => `<option value="${g}" ${sFilters.grade === g ? 'selected' : ''}>${g} grade</option>`).join('')}
    </select>
    <select id="sfDomain">
      <option value="ALL">Any domain interest</option>
      ${DOMAINS.map((d) => `<option value="${esc(d)}" ${sFilters.domain === d ? 'selected' : ''}>${esc(d)}</option>`).join('')}
    </select>
    ${
      me.team && me.team.slots.remaining > 0
        ? `<button id="sfEligible" class="chip ${sFilters.eligible ? 'active' : ''}" type="button">Eligible for my team</button>`
        : ''
    }
    <span id="studentCount" class="count"></span>
  </div>
  <div class="card">
    <input id="studentSearch" placeholder="🔎 Search by name or SRN…" value="${esc(studentQuery)}" autocomplete="off" />
    <div id="studentResults"><div class="empty">Loading students…</div></div>
  </div>`;
}

function studentResultsHtml(list) {
  if (list.length === 0)
    return `<div class="empty"><span class="big">🤷</span>No student matches ${studentQuery.trim() ? `“${esc(studentQuery)}”` : 'these filters'}.</div>`;
  return list
    .map((s) => {
      let status, joinBtn = '';
      if (s.team) {
        status = `<span class="badge taken">In team · ${esc(s.team.domain)}${s.team.full ? ' (full)' : ''}</span>`;
        // let the searcher request to join this student's team right here
        if (s.team.requested) {
          joinBtn = `<button class="btn small primary" disabled type="button">Request sent ✓</button>`;
        } else if (s.team.joinBlock === null) {
          joinBtn = `<button class="btn small primary" data-joinsteam="${s.team.id}" type="button">Request to join their team</button>`;
        } else if (typeof s.team.joinBlock === 'string') {
          joinBtn = `<button class="btn small primary" disabled title="${esc(s.team.joinBlock)}" type="button">Request to join their team</button>
            <p class="join-note">⚠️ ${esc(s.team.joinBlock)}</p>`;
        }
      } else {
        status = `<span class="badge free">Available — can join a team</span>`;
      }
      let eligible = '';
      if (s.invited)
        eligible = `<button class="btn small primary" disabled type="button">Invited ✓</button>`;
      else if (s.eligibleForMyTeam === null)
        eligible = `<button class="btn small success" data-invite="${esc(s.srn)}" type="button">➕ Invite to my team</button>`;
      else if (typeof s.eligibleForMyTeam === 'string')
        eligible = `<p class="join-note">⚠️ Can't invite: ${esc(s.eligibleForMyTeam)}</p>`;
      const interests = s.domains && s.domains.length
        ? `<div class="interest-row">🎯 ${s.domains.map((d) => `<span class="badge domain">${esc(d)}</span>`).join(' ')}</div>`
        : '';
      const waChip = s.whatsapp
        ? `<a class="wa-chip sm" href="https://wa.me/${esc(s.whatsapp)}" target="_blank" rel="noopener">💬 +${esc(s.whatsapp)}</a>`
        : `<span class="srn" style="font-size:0.75rem">no number shared</span>`;
      const isMe = s.srn === me.user.srn;
      return `<div class="student-row">
        <div style="flex:1">${memberRow(s, null)}${interests}</div>
        ${isMe ? '<span class="badge branch">You</span>' : waChip}
        <div>${status}</div>
        ${isMe ? '' : joinBtn}
        ${isMe ? '' : eligible}
      </div>`;
    })
    .join('');
}

let studentTimer;
async function searchStudents() {
  const box = $('studentResults');
  if (!box) return;
  try {
    const params = new URLSearchParams();
    if (studentQuery.trim()) params.set('q', studentQuery.trim());
    if (sFilters.gender !== 'ALL') params.set('gender', sFilters.gender);
    if (sFilters.grade !== 'ALL') params.set('grade', sFilters.grade);
    if (sFilters.domain !== 'ALL') params.set('domain', sFilters.domain);
    if (sFilters.eligible) params.set('eligible', '1');
    const list = await api('/students?' + params.toString());
    if (!$('studentResults')) return; // user switched tabs mid-fetch
    const counter = $('studentCount');
    if (counter) counter.textContent = `${list.length} student${list.length === 1 ? '' : 's'}`;
    $('studentResults').innerHTML = studentResultsHtml(list);
    // re-bind the "📂 n projects" toggles inside results
    $('studentResults').querySelectorAll('[data-toggle]').forEach((b) => {
      b.onclick = () => $(b.dataset.toggle).classList.toggle('hidden');
    });
    // join-their-team buttons
    $('studentResults').querySelectorAll('[data-joinsteam]').forEach((b) => {
      b.onclick = () => openJoinModal(b.dataset.joinsteam, true);
    });
    // leader invites a student to their team
    $('studentResults').querySelectorAll('[data-invite]').forEach((b) => {
      b.onclick = async () => {
        try {
          await api(`/teams/${me.team.id}/invite`, 'POST', { srn: b.dataset.invite });
          toast(`Invitation sent to ${b.dataset.invite} 📨`, 'ok');
          searchStudents();
        } catch (x) { toast(x.message); }
      };
    });
  } catch (x) { toast(x.message); }
}

// ---------- tab: my team ----------
function myTeamTabHtml() {
  if (!me.team) {
    const options = DOMAINS.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join('');
    return `<div class="section-head fade-up"><div><h2>My Team</h2><p>You're not in a team yet — create one and lead it</p></div></div>
    <div class="card">
      <h2>Create a team</h2>
      <p class="hint" style="margin-top:4px">Pick the project domain your team will work on (from the official list). You become the team leader.</p>
      <form id="createForm" class="create-grid">
        <label>Project domain
          <select id="domainSelect" required>
            <option value="">Select a domain…</option>
            ${options}
          </select>
        </label>
        <button class="btn primary" type="submit">Create team — you become leader</button>
      </form>
    </div>`;
  }

  const t = me.team;
  const isLeader = t.leader === me.user.srn;
  const myNote = t.memberNotes[me.user.srn] || '';

  // mentor section
  let mentorHtml = `<h3>Mentor</h3>`;
  if (t.mentor) {
    mentorHtml += `<div class="mentor-row">${profPhoto(t.mentor, 'lg')}
      <div><div class="mentor-name">${esc(t.mentor.name)}</div>
      <div class="mentor-sub">${esc(t.mentor.title)} · ${esc(t.mentor.dept)}</div></div>
      ${isLeader ? `<button class="btn small danger" data-mentor-remove type="button">Remove</button>` : ''}
    </div>`;
  } else if (isLeader) {
    const q = mentorQuery.toLowerCase();
    const list = professors.filter((p) => !q || `${p.name} ${p.dept} ${p.title}`.toLowerCase().includes(q));
    mentorHtml += `<p class="hint">No mentor yet — search a professor by name, or browse the list. You can also do this later.</p>
      <input id="mentorSearch" placeholder="Type a professor's name…" value="${esc(mentorQuery)}" autocomplete="off" />
      <div class="prof-list">${
        list.length
          ? list.map((p) => `<button class="prof-item" data-mentor="${esc(p.id)}" type="button">
              ${profPhoto(p, 'lg')}
              <span><span class="pi-name">${esc(p.name)}</span><br/><span class="pi-sub">${esc(p.title)} · ${esc(p.dept)}</span></span>
            </button>`).join('')
          : `<div class="empty">No professor matches “${esc(mentorQuery)}”</div>`
      }</div>`;
  } else {
    mentorHtml += `<p class="hint">No mentor chosen yet — your team leader will pick one.</p>`;
  }

  return `<div class="section-head fade-up"><div><h2>My Team</h2><p>Your project team for 3rd &amp; 4th year</p></div></div>
  <div class="card">
    ${teamCardHead(t, `<button class="btn small danger" data-leave="${t.id}" type="button">${isLeader ? 'Disband team' : 'Leave team'}</button>`)}

    ${mentorHtml}

    <h3>Members</h3>
    ${t.members
      .map((m) =>
        memberRow(
          m,
          t.leader,
          t.memberNotes[m.srn],
          isLeader && m.srn !== me.user.srn
            ? `<button class="btn small danger" data-kick="${esc(m.srn)}" type="button">Remove</button>`
            : ''
        )
      )
      .join('')}

    <h3>My description &amp; GitHub <span style="text-transform:none;letter-spacing:0">— only you can edit yours</span></h3>
    <form id="noteForm">
      <textarea id="noteInput" maxlength="400" placeholder="e.g. Built a chat app in React, done 2 ML hackathons, comfortable with Python and Figma…">${esc(myNote)}</textarea>
      <div class="inline-form" style="margin-top:10px">
        <input id="myGithub" placeholder="Your GitHub — https://github.com/yourname" value="${esc(me.user.github)}" />
        <button class="btn small primary" type="submit">Save</button>
      </div>
    </form>

    ${slotRow(t.slots)}
    ${t.slots.remaining > 0 ? `<p class="join-note">💡 Any member can accept requests or invite students — check the <strong>Requests</strong> and <strong>Students</strong> tabs.</p>` : ''}
  </div>`;
}

// ---------- tab: requests ----------
function requestsHtml() {
  let html = `<div class="section-head fade-up"><div><h2>Requests</h2><p>Join requests and team invitations</p></div></div>`;

  // invitations sent TO me by team leaders
  const pendingInv = me.invites.filter((i) => i.status === 'pending');
  const decidedInv = me.invites.filter((i) => i.status !== 'pending');
  if (me.invites.length > 0) {
    html += `<div class="card"><h2>Invitations — teams that want you 🎉</h2>`;
    html += [...pendingInv, ...decidedInv]
      .map((i) =>
        i.status === 'pending'
          ? `<div class="req-row">
              <span><strong>${esc(i.teamDomain)}</strong> <span class="badge branch">${esc(i.teamBranch)}</span>
              <span class="srn"> · led by ${esc(i.leaderName)}</span></span>
              <div class="req-actions">
                <button class="btn small success" data-inv-accept="${i.id}" type="button">Accept &amp; join</button>
                <button class="btn small danger" data-inv-reject="${i.id}" type="button">Decline</button>
              </div>
            </div>`
          : `<div class="req-row"><span>${esc(i.teamDomain)}<span class="srn"> · led by ${esc(i.leaderName)}</span></span>
              <span class="badge status-${i.status}">${i.status}</span></div>`
      )
      .join('');
    html += `</div>`;
  }

  // invitations my team has sent (any member can see + cancel)
  if (me.team && me.sentInvites.length > 0) {
    html += `<div class="card"><h2>Invites my team has sent</h2>
      ${me.sentInvites
        .map(
          (i) => `<div class="req-row"><span>${esc(i.name)} <span class="srn">${esc(i.srn)}</span></span>
            ${
              i.status === 'pending'
                ? `<button class="btn small danger" data-inv-cancel="${i.id}" type="button">Cancel invite</button>`
                : `<span class="badge status-${i.status}">${i.status}</span>`
            }</div>`
        )
        .join('')}
    </div>`;
  }
  // incoming join requests — any member of the team can act on them
  if (me.team) {
    html += `<div class="card"><h2>Incoming — students who want to join</h2>`;
    if (me.incoming.length === 0) {
      html += `<div class="empty"><span class="big">📭</span>No pending requests.<br/>Tell your classmates to find your team under <strong>${esc(me.team.domain)}</strong>.</div>`;
    } else {
      html += me.incoming
        .map(
          (r) => `<div class="req-row">
            <div style="flex:1">${memberRow(r.user, null)}
              ${r.candidateTeam ? `<p class="join-note">ℹ️ Already joined team "${esc(r.candidateTeam)}" — request stays here in case they leave it</p>` : ''}
            </div>
            <div class="req-actions">
              ${r.whatsapp ? `<a class="wa-chip" href="https://wa.me/${esc(r.whatsapp)}" target="_blank" rel="noopener" title="+${esc(r.whatsapp)}">💬 WhatsApp</a>` : ''}
              <button class="btn small success" data-accept="${r.id}" ${r.candidateTeam ? 'disabled title="Currently in another team"' : ''} type="button">Accept</button>
              <button class="btn small danger" data-reject="${r.id}" type="button">Reject</button>
            </div>
          </div>`
        )
        .join('');
    }
    html += `</div>`;
  }

  html += `<div class="card"><h2>Sent by me</h2>`;
  if (me.outgoing.length === 0) {
    html += `<div class="empty"><span class="big">✉️</span>You haven't requested to join any team yet.</div>`;
  } else {
    const pending = me.outgoing.filter((r) => r.status === 'pending');
    const decided = me.outgoing.filter((r) => r.status !== 'pending');
    html += [...pending, ...decided]
      .map(
        (r) => `<div class="req-row"><span>${esc(r.teamDomain)}</span>
          ${
            r.status === 'pending'
              ? `<button class="btn small danger" data-cancel-req="${r.id}" type="button">Cancel request</button>`
              : `<span class="badge status-${r.status}">${r.status}</span>`
          }</div>`
      )
      .join('');
  }
  html += `</div>`;
  return html;
}

// ---------- tab: my profile ----------
function profileHtml() {
  const u = me.user;
  let html = `<div class="section-head fade-up"><div><h2>My Profile</h2><p>Your showcase is visible to everyone browsing teams — help like-minded people find you</p></div></div>

  <div class="card">
    <h2>My details</h2>
    <p class="hint" style="margin-top:4px">SRN can't be changed — it's your account ID.${me.team ? " Since you're in a team, changes that would break its grade/gender/branch rules will be rejected." : ''}</p>
    <form id="editForm" class="create-grid">
      <div class="row2">
        <label>SRN <input value="${esc(u.srn)}" disabled /></label>
        <label>Full name <input id="editName" required maxlength="60" value="${esc(u.name)}" /></label>
      </div>
      <div class="row2">
        <label>Branch
          <select id="editBranch" required>
            ${BRANCHES.map((b) => `<option value="${b}" ${u.branch === b ? 'selected' : ''}>${b}</option>`).join('')}
          </select>
        </label>
        <label>Gender
          <select id="editGender" required>
            <option value="M" ${u.gender === 'M' ? 'selected' : ''}>Male</option>
            <option value="F" ${u.gender === 'F' ? 'selected' : ''}>Female</option>
          </select>
        </label>
      </div>
      <div class="row2">
        <label>CGPA <input id="editCgpa" type="number" step="0.01" min="0" max="10" required value="${u.cgpa}" /></label>
        <label>WhatsApp number <input id="editWa" inputmode="tel" maxlength="16" value="${esc(u.whatsapp)}" placeholder="Shown to classmates" /></label>
      </div>
      <label>New password <input id="editPw" type="password" minlength="4" placeholder="Leave blank to keep current" /></label>
      <button class="btn primary" type="submit">Save changes</button>
    </form>
  </div>

  <div class="card">
    <h2>Interested domains</h2>
    <p class="hint" style="margin-top:4px">Pick from the list — these show on your directory entry so teams working on what you love can find you. (Custom domains are only for naming a team you create.)</p>
    <div class="chips" style="margin:6px 0 14px">
      ${DOMAINS.map((d) => `<button class="chip interest ${u.domains.includes(d) ? 'active' : ''}" data-interest="${esc(d)}" type="button">${esc(d)}</button>`).join('')}
    </div>
    <button id="saveDomainsBtn" class="btn primary" type="button">Save interests</button>
  </div>

  <div class="card">
    <h2>Project showcase</h2>
    <p class="hint" style="margin-top:4px">Projects you've worked on — shown when people expand your name on team cards and join requests.</p>`;

  if (u.projects.length === 0) {
    html += `<div class="empty"><span class="big">📂</span>Nothing here yet — add your first project below.</div>`;
  } else {
    html += `<div class="projects" style="margin:10px 0 0">${u.projects.map((p) => projectItem(p, true)).join('')}</div>`;
  }

  html += `
    <h3>Add a project</h3>
    <form id="projForm" class="create-grid">
      <label>Title <input id="projTitle" maxlength="60" required placeholder="e.g. Attendance app for my class" /></label>
      <label>What you did <textarea id="projDesc" maxlength="300" placeholder="Short description — tech used, what you built…"></textarea></label>
      <label>Link (optional) <input id="projLink" placeholder="https://github.com/you/repo" /></label>
      <button class="btn primary" type="submit">Add to showcase</button>
    </form>
  </div>

  <div class="card danger-zone">
    <h2>Danger zone</h2>
    <p class="hint" style="margin-top:6px">Deleting your account removes you from your team${me.team && me.team.leader === u.srn ? ' and <strong>disbands it</strong> (you are the leader)' : ''}, cancels your requests and erases your profile. This cannot be undone.</p>
    <button id="deleteAccountBtn" class="btn danger" type="button">Delete my account</button>
  </div>`;
  return html;
}

// ---------- actions ----------
function bindActions() {
  document.querySelectorAll('[data-filter]').forEach((b) => {
    b.onclick = () => { filters.branch = b.dataset.filter; render(); };
  });
  // students search (debounced so we don't hammer the server per keystroke)
  const studentSearch = $('studentSearch');
  if (studentSearch)
    studentSearch.oninput = () => {
      studentQuery = studentSearch.value;
      clearTimeout(studentTimer);
      studentTimer = setTimeout(searchStudents, 300);
    };

  const bindSel = (id, key) => {
    const el = $(id);
    if (el) el.onchange = () => { filters[key] = el.value; render(); };
  };
  bindSel('fDomain', 'domain');
  bindSel('fGrade', 'grade');
  bindSel('fGender', 'gender');

  // students directory filters (no full re-render — just refetch the list)
  const bindSFilter = (id, key) => {
    const el = $(id);
    if (el) el.onchange = () => { sFilters[key] = el.value; searchStudents(); };
  };
  bindSFilter('sfGender', 'gender');
  bindSFilter('sfGrade', 'grade');
  bindSFilter('sfDomain', 'domain');
  const sfEligible = $('sfEligible');
  if (sfEligible)
    sfEligible.onclick = () => {
      sFilters.eligible = !sFilters.eligible;
      sfEligible.classList.toggle('active', sFilters.eligible);
      searchStudents();
    };

  // profile: interested-domain chips (toggle, then save)
  document.querySelectorAll('[data-interest]').forEach((b) => {
    b.onclick = () => b.classList.toggle('active');
  });
  const saveDomainsBtn = $('saveDomainsBtn');
  if (saveDomainsBtn)
    saveDomainsBtn.onclick = async () => {
      const domains = [...document.querySelectorAll('.chip.interest.active')].map((b) => b.dataset.interest);
      try {
        await api('/profile/domains', 'POST', { domains });
        toast('Interests saved — you\'re now discoverable by domain 🎯', 'ok');
        await refresh();
      } catch (x) { toast(x.message); }
    };
  const clearBtn = $('clearFilters');
  if (clearBtn)
    clearBtn.onclick = () => {
      filters = { branch: 'ALL', domain: 'ALL', grade: 'ALL', gender: 'ALL' };
      render();
    };

  // expandable project showcases
  document.querySelectorAll('[data-toggle]').forEach((b) => {
    b.onclick = () => $(b.dataset.toggle).classList.toggle('hidden');
  });

  const createForm = $('createForm');
  if (createForm) {
    createForm.onsubmit = async (e) => {
      e.preventDefault();
      const domain = $('domainSelect').value;
      if (!domain) return toast('Please pick a domain from the list');
      try {
        await api('/teams', 'POST', { domain });
        toast('Team created! You are the leader 👑', 'ok');
        activeTab = 'team';
        await refresh();
      } catch (x) { toast(x.message); }
    };
  }

  // my own description + personal github
  const noteForm = $('noteForm');
  if (noteForm)
    noteForm.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api(`/teams/${me.team.id}/note`, 'POST', { text: $('noteInput').value });
        await api('/profile/github', 'POST', { url: $('myGithub').value });
        toast('Saved — your description and GitHub are updated', 'ok');
        await refresh();
      } catch (x) { toast(x.message); }
    };

  // mentor picker
  const mentorSearch = $('mentorSearch');
  if (mentorSearch)
    mentorSearch.oninput = () => {
      mentorQuery = mentorSearch.value;
      render();
      const el = $('mentorSearch');
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    };
  document.querySelectorAll('[data-mentor]').forEach((b) => {
    b.onclick = async () => {
      try {
        await api(`/teams/${me.team.id}/mentor`, 'POST', { professorId: b.dataset.mentor });
        mentorQuery = '';
        toast('Mentor added to your team 🎓', 'ok');
        await refresh();
      } catch (x) { toast(x.message); }
    };
  });
  document.querySelectorAll('[data-mentor-remove]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Remove the mentor from your team?')) return;
      try {
        await api(`/teams/${me.team.id}/mentor`, 'POST', { professorId: null });
        await refresh();
      } catch (x) { toast(x.message); }
    };
  });

  // profile: edit my details
  const editForm = $('editForm');
  if (editForm)
    editForm.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/profile', 'POST', {
          name: $('editName').value,
          branch: $('editBranch').value,
          gender: $('editGender').value,
          cgpa: $('editCgpa').value,
          whatsapp: $('editWa').value,
          password: $('editPw').value,
        });
        toast('Your details are updated', 'ok');
        await refresh();
      } catch (x) { toast(x.message); }
    };

  // profile: add / delete showcase projects
  const projForm = $('projForm');
  if (projForm)
    projForm.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/profile/projects', 'POST', {
          title: $('projTitle').value,
          description: $('projDesc').value,
          link: $('projLink').value,
        });
        toast('Project added to your showcase', 'ok');
        await refresh();
      } catch (x) { toast(x.message); }
    };
  document.querySelectorAll('[data-delproj]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Remove this project from your showcase?')) return;
      try { await api(`/profile/projects/${b.dataset.delproj}`, 'DELETE'); await refresh(); } catch (x) { toast(x.message); }
    };
  });

  // delete account
  const delBtn = $('deleteAccountBtn');
  if (delBtn)
    delBtn.onclick = async () => {
      if (!confirm('Delete your account permanently? This cannot be undone.')) return;
      if (!confirm('Are you really sure? Your team spot, requests and showcase will all be erased.')) return;
      try {
        await api('/account', 'DELETE');
        toast('Account deleted. Bye 👋', 'ok');
        logout();
      } catch (x) { toast(x.message); }
    };

  document.querySelectorAll('[data-join]').forEach((b) => {
    b.onclick = () => openJoinModal(b.dataset.join, false);
  });

  // leader removes a member
  document.querySelectorAll('[data-kick]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm(`Remove ${b.dataset.kick} from the team? Their description will be removed too.`)) return;
      try {
        await api(`/teams/${me.team.id}/kick`, 'POST', { srn: b.dataset.kick });
        toast('Member removed from the team', 'ok');
        refresh();
      } catch (x) { toast(x.message); }
    };
  });
  document.querySelectorAll('[data-accept]').forEach((b) => {
    b.onclick = async () => {
      try {
        await api(`/requests/${b.dataset.accept}`, 'POST', { action: 'accept' });
        toast('Member added to the team 🎉', 'ok');
      } catch (x) { toast(x.message); }
      refresh();
    };
  });
  document.querySelectorAll('[data-reject]').forEach((b) => {
    b.onclick = async () => {
      try {
        await api(`/requests/${b.dataset.reject}`, 'POST', { action: 'reject' });
        refresh();
      } catch (x) { toast(x.message); }
    };
  });
  // student accepts / declines a team invitation
  document.querySelectorAll('[data-inv-accept]').forEach((b) => {
    b.onclick = async () => {
      try {
        await api(`/invites/${b.dataset.invAccept}`, 'POST', { action: 'accept' });
        toast('Welcome to the team! 🎉', 'ok');
        activeTab = 'team';
      } catch (x) { toast(x.message); }
      refresh();
    };
  });
  document.querySelectorAll('[data-inv-reject]').forEach((b) => {
    b.onclick = async () => {
      try {
        await api(`/invites/${b.dataset.invReject}`, 'POST', { action: 'reject' });
        refresh();
      } catch (x) { toast(x.message); }
    };
  });
  // team member cancels a sent invite
  document.querySelectorAll('[data-inv-cancel]').forEach((b) => {
    b.onclick = async () => {
      try {
        await api(`/invites/${b.dataset.invCancel}`, 'POST', { action: 'cancel' });
        toast('Invite cancelled', 'ok');
        refresh();
      } catch (x) { toast(x.message); }
    };
  });
  // student cancels their own sent join request
  document.querySelectorAll('[data-cancel-req]').forEach((b) => {
    b.onclick = async () => {
      try {
        await api(`/requests/${b.dataset.cancelReq}`, 'POST', { action: 'cancel' });
        toast('Request cancelled', 'ok');
        refresh();
      } catch (x) { toast(x.message); }
    };
  });
  document.querySelectorAll('[data-leave]').forEach((b) => {
    b.onclick = async () => {
      const isLeader = me.team.leader === me.user.srn;
      if (!confirm(isLeader ? 'Disband the team? All members will be removed.' : 'Leave this team?')) return;
      try { await api(`/teams/${b.dataset.leave}/leave`, 'POST'); refresh(); } catch (x) { toast(x.message); }
    };
  });
}

// ---------- join request modal (with optional WhatsApp) ----------
let pendingJoin = null; // { teamId, fromStudents }

function openJoinModal(teamId, fromStudents) {
  pendingJoin = { teamId, fromStudents };
  $('waInput').value = (me && me.user.whatsapp) || localStorage.getItem('wa') || '';
  $('joinModal').classList.remove('hidden');
  $('waInput').focus();
}
function closeJoinModal() {
  pendingJoin = null;
  $('joinModal').classList.add('hidden');
}
$('waCancel').onclick = closeJoinModal;
$('joinModal').onclick = (e) => { if (e.target.id === 'joinModal') closeJoinModal(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeJoinModal(); });
$('waSend').onclick = async () => {
  if (!pendingJoin) return;
  const wa = $('waInput').value.trim();
  const { teamId, fromStudents } = pendingJoin;
  try {
    await api(`/teams/${teamId}/join`, 'POST', { whatsapp: wa });
    if (wa) localStorage.setItem('wa', wa); // remember for next time
    closeJoinModal();
    toast('Request sent — waiting for the leader to accept', 'ok');
    await refresh();
    if (fromStudents) searchStudents();
  } catch (x) { toast(x.message); }
};

// ---------- background video: fall back to the gradient if it can't load ----------
const bgVideo = $('bgVideo');
if (bgVideo) bgVideo.addEventListener('error', () => bgVideo.remove(), true);

// ---------- material ripple on buttons / tabs / chips ----------
document.addEventListener('pointerdown', (e) => {
  const el = e.target.closest('.btn, .mtab, .tab, .chip, .prof-item');
  if (!el || el.disabled) return;
  const r = el.getBoundingClientRect();
  const d = Math.max(r.width, r.height) * 1.1;
  const s = document.createElement('span');
  s.className = 'ripple';
  s.style.width = s.style.height = d + 'px';
  s.style.left = e.clientX - r.left - d / 2 + 'px';
  s.style.top = e.clientY - r.top - d / 2 + 'px';
  el.appendChild(s);
  setTimeout(() => s.remove(), 600);
});

// ---------- refresh loop ----------
let lastSnapshot = ''; // skip re-rendering when nothing changed (fixes scroll jumping to top)
async function refresh() {
  if (!token) return showAuth();
  try {
    if (professors.length === 0) professors = await api('/professors').catch(() => []);
    [me, teams] = await Promise.all([api('/me'), api('/teams')]);
    // don't wipe the page while the user is typing in a form
    const el = document.activeElement;
    const typing = el && $('content').contains(el) && ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName);
    if (typing) return;
    // only re-render if the data actually changed — otherwise leave the page (and scroll) alone
    const snap = JSON.stringify([me, teams]);
    if (snap === lastSnapshot) return;
    lastSnapshot = snap;
    const y = window.scrollY;
    render();
    window.scrollTo(0, y); // keep the user where they were
  } catch (e) {
    if (token) toast(e.message);
  }
}

refresh();
// background sync every 30s (user actions always refresh instantly on their own)
setInterval(() => { if (token && me) refresh(); }, 30000);
