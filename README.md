# TeamUp — BTech Project Team Finder

Website for forming 4-member project teams (3rd/4th year BTech).

## Team rules (enforced automatically)

- Exactly **4 members** per team
- At least **one A, one B and one C grade** (the 4th member can repeat any grade)
  - A = CGPA 8+ · B = CGPA 7–8 · C = below 7
- Gender mix must be **1–3 male and 1–3 female** (1M/3F, 2M/2F or 3M/1F)
- **Same branch only** — teams belong to the leader's branch (CSE / AIML / ECE);
  students from other branches get an error when they try to join
- Teams are identified by their **project domain** (picked from a dropdown, or a
  custom one) instead of a team name
- Whoever creates a team is the **leader** — join requests go to them to accept/reject
- Team browser shows exactly which grade slots and gender slots are still open,
  with branch filter chips
- Your exact CGPA is private — others only see your grade letter (A/B/C)

## Other features

- **My Profile tab** — showcase projects you've worked on (title, description,
  link); visible to anyone browsing teams or reviewing your join request.
  Also where you can **delete your account** (leader deletion disbands the team).
- **Team GitHub link** — set by the leader, shown as a chip on team cards.
- **Member descriptions** — every member writes their own "what I've worked on"
  blurb on the team page; the server only ever writes it under the caller's own
  SRN, so nobody can edit anyone else's.
- **Mentor** — the leader picks a professor (searchable list with photos) now or
  later; the mentor's name + photo show on Browse Teams. Professors live in
  `professors.json` (currently placeholder data — replace with real faculty
  scraped from the college website).

## Run it

```bash
cd team-finder
npm install
npm start
```

Open http://localhost:3000

All data is stored in `data.json` next to `server.js` (created automatically).
Delete that file to reset everything.

## Sharing with classmates

`localhost` only works on your machine. To let the whole class use it:

- **Same WiFi:** run `npm start`, find your IP with `ipconfig getifaddr en0`,
  share `http://<your-ip>:3000`
- **On the internet (free):** deploy to [Render](https://render.com) or
  [Railway](https://railway.app) — create a "Web Service" from this folder,
  build command `npm install`, start command `npm start`.
  Note: on free tiers the `data.json` file may be wiped when the service
  restarts — fine for a semester sign-up sprint, but export/back up the file
  if the data matters.
