# TeamUp — project conventions

Capstone team-formation site for PES ECity (BTech 3rd/4th year). Node.js + Express,
vanilla HTML/CSS/JS frontend (no build step), JSON-file database.

## Architecture

- `server.js` — the whole API. All rules are validated **server-side**; the UI only mirrors them.
- `public/` — `index.html`, `app.js`, `style.css`. Material Design 3, green palette, glassmorphism over a nature video.
- `data.json` — the database (gitignored). **NEVER delete, overwrite, or wipe it without explicit user approval.**
- `professors.json` — real PES ECity faculty (CSE/AIML/ECE) scraped from staff.pes.edu, used for mentors.

## Team rules (the core invariants — never weaken these)

- Exactly 4 members per team.
- At least one A (CGPA ≥ 8), one B (7–8), and one C (< 7) grade member.
- 1–3 male AND 1–3 female members.
- Same branch only (team inherits its leader's branch: CSE / AIML / ECE).
- Slot feasibility: a grade slot is "open" only if, after filling it, the remaining
  missing grades still fit in the remaining seats.
- Team domains and profile interests come ONLY from the DOMAINS list
  (duplicated in `server.js` and `app.js` — keep both in sync).
- Rules are checked at request time, invite time, accept time, AND profile-edit time.

## Permissions

| Action | Who |
|---|---|
| Accept/reject join requests, send/cancel invites | any team member |
| Kick a member, disband team, choose mentor, team description | leader only |
| Cancel a sent join request | the requester only |
| Edit profile, bio, GitHub, interests | the owner only |

- Joining a team must NOT cancel the student's other pending requests — they are
  kept "just in case", with an already-in-a-team notice shown to the other teams.

## Privacy

- Exact CGPA is visible only to its owner; everyone else sees the grade letter.
- Passwords: salted scrypt, never logged or returned.

## Working rules

- After any server change: `node --check`, restart, and verify the behavior with
  curl against real endpoints before declaring it done.
- Test with temp accounts registered via the API, then delete them via
  DELETE /api/account — never mutate or delete real users' data.
- Git: small commits, ONE feature per commit, short imperative message
  (e.g. "Browse: hide full teams by default"). No Co-Authored-By trailers.
  Push to github.com/avaneesh1830/TeamUp when asked.
- Docker image: `avaneesharoor/teamup` — remind the user to rebuild+push after changes.
