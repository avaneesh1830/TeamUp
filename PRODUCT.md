# TeamUp — Product Sheet

**Capstone team formation, done right.** A web portal that replaces the WhatsApp-group
chaos of finding a project team with a system where the rules enforce themselves and
finding the *right* teammates takes seconds.

> *Made in PESU for PESU* ❤️ · Capstone 2026–28 · CSE / AIML / ECE

---

## The problem

Every 3rd-year student needs a 4-person team for a two-year capstone, under strict
university rules (grade mix, branch, gender balance). Today this happens over WhatsApp:
messy, error-prone, and impossible to verify a team is even valid until it's too late.

## The solution

TeamUp makes an **invalid team impossible to form** and makes **finding compatible
teammates effortless** — with live filters, a searchable directory, faculty mentors,
and an AI assistant, all on one page.

---

## Core features

### 🧩 Rule-enforcing team formation
- Teams of **exactly 4**; the system blocks any invalid combination in real time
- **Grade mix** must be one of **AABC · ABBC · ABCC · AACC · BBCC** (A = CGPA 8+, B = 7–7.99, C = <7)
- **CSE + AIML can combine**; ECE teams are ECE-only
- **Mixed-gender preferred, not forced** — all-male / all-female teams allowed
- Every team card shows **which grade slots are still open**, computed live
- Rules re-checked at join, invite, accept, and even profile-edit time — no loopholes

### 🔎 Finding teammates
- **Browse Teams** — filter by branch, domain, open grade slot; "Eligible to join" one-tap filter
- **Student directory** — search 1,500+ students by name/SRN; see who's free vs. teamed up;
  filter by branch, gender, grade, and domain interest
- **Request to join** from a team card *or* straight from a student's search result
- **Team invites** — any member can invite eligible students; students accept/decline

### 👥 Team management
- Leader **👑 role** with approve/reject, kick, disband, and **leadership transfer**
- Any member can accept requests & send invites; only the leader can kick/disband
- Team **description** (leader-written) + per-student **bio, GitHub, project showcase**
- **WhatsApp contact** shared on requests so leaders can vibe-check before accepting

### 👨‍🏫 Faculty mentors
- Real **PES EC-campus faculty directory** — names, photos, designations, emails, domain expertise
- Searchable by name or domain; leaders attach a mentor to their team

### ✨ AI Assistant (optional)
- In-app chatbot: *"Any FinTech teams with a seat?"*, *"Which team is Priya in?"*,
  *"Suggest mentors for Blockchain"*
- **Tool-calling over live data** — answers are always real, never hallucinated
- Runs on a small local model (Ollama + Qwen), CPU-only, on the same college server

### 🔐 Privacy, security & accounts
- **Exact CGPA never shown** — only the grade letter (A/B/C)
- **Salted scrypt** password hashing; multi-device sessions (up to 5)
- **Email OTP** on registration and password reset; **3 password changes/day** limit
- Anti-enumeration on forgot-password; unique-email enforcement
- **Activity log** of every registration, join, leave, and disband

---

## Built to launch

| Concern | How it's handled |
|---|---|
| **Scale** | Load-tested at **1,600 students / 350 teams** — 20–40 ms per request, 200 concurrent requests served in ~3 s |
| **Database** | **SQLite** — a real relational DB in a single file. No separate DB server for IT to run (unlike MongoDB), ACID transactions, portable to MySQL/PostgreSQL later |
| **Reliability** | WAL mode + atomic writes — verified crash-safe with `kill -9` mid-write, zero data loss |
| **Data loss** | Nightly SQLite backups, 14-day retention |
| **Hosting** | One Docker command; auto-restarts on crash/reboot; data on a persistent college-disk volume |
| **Mobile** | Fully responsive — works on phones, the device most students will use |

---

## Tech at a glance

- **Backend:** Node.js + Express (single service, ~900 lines)
- **Database:** SQLite via better-sqlite3 (indexed, ACID, one file)
- **Frontend:** vanilla HTML/CSS/JS — no framework, no build step, Material-inspired UI
- **AI:** Ollama + Qwen (local, tool-calling, no GPU required)
- **Deploy:** Docker image on Docker Hub; systemd alternative; Caddy for automatic HTTPS

---

## Server requirements

| | Without AI | With AI assistant |
|---|---|---|
| CPU | 4 cores | 4–8 cores |
| RAM | 8 GB | 16 GB |
| Disk | 25 GB | 30 GB |
| GPU | none | none (CPU is enough) |

**One process to host, one file for the database — that's the whole operational footprint.**

---

*Repo: github.com/avaneesh1830/TeamUp · Image: avaneesharoor/teamup · Built by Avaneesh Aroor*
