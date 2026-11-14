# KONVO — UX Audit and Redesign Blueprint

Status: **for review. Nothing in this document has been implemented.** No application code, API, schema, permission or integration is changed by it.
Basis: the repository at commit `d4d5eda` (branch `claude/teampulse-mvp`), read file by file. Statements about what exists were checked in code; anything not verified is marked *(not verified)*. Older documents were not relied on.

Every proposed change is tagged:

- **[IMPROVE]** an existing feature, made clearer or easier, same place.
- **[REORG]** an existing feature, moved, merged or renamed. Behaviour and routes keep working.
- **[NEW]** new guidance or interface element. It uses only data that already exists; no new metrics, no new APIs unless stated.

---

## 0. Summary

**What KONVO has today.** A complete product: task lifecycle with acceptance and review, a Kanban workboard, contribution records with four honest stages, evidence collection with attribution rules, assessments with employee correction and dispute, manager verification, Work Intelligence, alerts, reports, Slack intake and automations. The substance is strong and fair-by-design.

**The core problem is not missing features. It is that the product is hard to read.**

1. The same idea has several names, and the sidebar label often differs from the page title (for example *Work Analytics* opens *Work Intelligence*; *Slack Intake* opens *Work from Slack*; *Analyse My Day* opens *AI Work Assistant*).
2. A manager has **five separate places** where "something needs my decision", each with its own count.
3. The manager sidebar has **16 links plus 2 in the footer**, mixing daily work and rare administration, and repeats the employee's pages under "My work".
4. There is **no first-run guidance** for either role. A new user lands straight on the board.
5. The employee's route to "my contribution" is scattered over five pages and is easy to miss.
6. Internal vocabulary leaks into the interface (L1–L4, "complexity expectation", "dimensions", "signals", "unconfirmed").

**Recommendation.** Keep every feature and every route. Re-organise the navigation around the two roles' real questions, merge the five manager inboxes into one Reviews hub, give the employee one My Contributions hub, add a short first-run checklist driven by real data, and unify the words and the visual system. Roughly 90% of this is front-end reorganisation. Section 12 marks the few items that would need backend work or a decision.

**Decisions needed from you** are collected in section 14.

---

## 1. Existing application map

### 1.1 Roles and access (server-enforced)

| Role | Sees | Notes |
|---|---|---|
| Admin | whole organization | also Alert settings, organization settings |
| Manager | themselves, and the people in teams they manage | manage tasks of those teams; review, verify, approve |
| Employee | their own tasks (assigned or created by them), their own profile | five per-employee permission flags set by a manager: *can create tasks*, *can create directly*, *can self-assign*, *can assign others*, *approval required*. Without them the "New task" button becomes "Suggest a task" |

Out-of-scope records answer 404, so existence is not revealed. There is **no mentor, captain or read-only reviewer role**; the database only allows `admin`, `manager`, `employee`.

### 1.2 Public and account pages

| Route | Page | Purpose today |
|---|---|---|
| landing | Landing | product story: "Work volume is not work value", the tagline, fairness, how teams work |
| `#/login`, `#/signup`, `#/forgot`, `#/reset/…`, `#/verify/…` | Auth | Google or email/password sign-in; local dev sign-in only locally |
| `#/invite/…` | Accept invitation | join an organization from an email link |
| (signed in, no org) | Welcome | invitations, join with a code, or create an organization if allowed |
| (deactivated) | Account deactivated | explains access was turned off |

### 1.3 Signed-in pages

| Route | Page title | Employee | Manager | Purpose today |
|---|---|---|---|---|
| `#/dashboard` | My workboard / Team Workboard | yes | yes | Kanban in five columns (To do, In progress, Blocked, In review, Done); metrics; filters. Manager also gets the "Contributions that matter" strip and a Review Queue link. Employee also gets the acceptance inbox and a collapsed Daily reflection |
| `#/my-tasks` | My tasks | yes | yes | own tasks grouped by urgency and state |
| `#/team-tasks` | Team tasks | blocked (friendly message) | yes | table of every task in scope, with filters |
| `#/tasks/:id` | task title | yes | yes | the full task: what, expectations, source, facts, submission and review, deadline context, contribution analysis, activity and comments, blockers, evidence, share |
| `#/requests` | Task requests | yes | yes | suggestions from employees and external automations; managers approve or decline |
| `#/impact`, `#/impact/:id` | Outcomes & impact | yes | yes | **the Contribution Record**: record, edit, add evidence, manager verifies or declines with a reason; stage Claimed / Supported / Reviewed / Verified |
| `#/contribution` | Team intelligence | redirected to own profile | yes | people list with complexity mix, awaiting review, evidence to resolve |
| `#/contribution/:id` | person name / My contribution | own only | scoped people | the contribution profile: summary, assigned tasks, evidence, contributions, assessment dimensions, outcomes, analysed work |
| `#/contributions`, `#/journey/:id` | Contribution journeys | yes | yes | each piece of work as a journey from request to outcome |
| `#/evidence` | My work evidence | yes | yes | what KONVO noticed in connected apps, and which task it belongs to; the person confirms or rejects matches |
| `#/assistant` | AI Work Assistant ("Analyse my day") | yes | yes | a digest of the person's own day from records; AI is optional and only for a write-up |
| `#/copilot` | Ask about your team ("Manager Copilot") | blocked | yes | answers built from team records, each linked to its source |
| `#/reviews` | Contribution reviews | redirected | yes | decisions only a manager can make: judge analyses, approve work, verify outcomes, decide whose work it is |
| `#/review` | Review queue | blocked | yes | priorities and deadlines awaiting confirmation; change requests |
| `#/analytics` | Work Intelligence | person view only | Team, Person, Task tabs | people-first team list, outcomes; person and task analytics |
| `#/slack-intake` | Work from Slack | blocked | yes | tasks created from Slack messages: source, tagged person, owner, waiting acceptance |
| `#/automations` | Connected apps / Automation Center | yes | yes | connect apps; ready-made automations; Advanced Builder |
| `#/alerts` | Alerts & notifications | yes | yes | in-app notifications; important ones also via M91 |
| `#/reports` | Reports | blocked | yes | weekly and operational reports |
| `#/settings/*` | Settings | profile only | + Organization, Teams & members, Employee permissions, Audit history; admin: Alert settings | |

### 1.4 Navigation today

- **Manager sidebar (16 + 2):** Overview, Team Intelligence, Tasks, Slack Intake, Review Queue, Work Analytics, Contribution Reviews, Manager Copilot, Contribution Journeys, Connected Apps; section *My work*: My Tasks, My Work Evidence, Analyse My Day; section *More*: Task Requests, Outcomes, Reports; footer: Alerts, Settings. Counts appear on Review Queue, Contribution Reviews, Task Requests and Alerts.
- **Employee sidebar (10 + 1):** My Overview, My Tasks, My Work Evidence, Contribution Journeys, Analyse My Day, Connected Apps, Profile; *More*: Task Requests, My Work Analytics, Outcomes; footer: Alerts.
- **Phone:** a bottom bar with four tabs plus *More* (which opens the full sidebar as a drawer). Manager: Overview, Team, Tasks, Reviews. Employee: Overview, Tasks, Journeys, Analyse.

### 1.5 State patterns that exist

Shared helpers exist for empty states (`empty()`, used about 40 times), loading skeletons, an error block with Retry, toasts, confirm dialogs, badges and avatars. Copy quality varies page by page. There is **no first-run guide, checklist or tour** anywhere in the front end (searched).

### 1.6 What the data can already say (so the redesign never needs fake metrics)

Task status and derived conditions (overdue, at risk, blocked hours); confirmed deadline and priority; progress percentage; latest meaningful activity; open blockers (external or not); acceptance state; contribution stage; evidence counts; assessment dimensions per task with reason and evidence; manager and employee review states; verified outcomes (shared counted once); alerts and signals; audit history.

---

## 2. Existing employee journey (traced through the code)

| Step | Where it happens today | Friction found |
|---|---|---|
| 1. Arrive | Landing → sign in → (Welcome if no org) → `#/dashboard` | Welcome only offers join/create; nothing explains KONVO or the role |
| 2. See my work | "My workboard": inbox, four numbers, five columns | Good. But nothing says what each column means or what to do first |
| 3. Accept or decline | inbox card ("Waiting for your answer") or the task page | Works. The inbox only shows when something waits, so the first-time user never sees it explained |
| 4. Start | drag To do → In progress, the card menu, or the task page | Only three moves are allowed; other drops explain why, but only after dropping |
| 5. Update progress | task page: "Update progress" | requires opening the task |
| 6. Report a blocker | task page: "Report blocker" | right action, but the page is long and the button sits among many |
| 7. Submit | task page: "Submit for review" (summary, outcome, evidence links) | fine; the meaning of "In review" is not explained |
| 8. Wait / feedback | task banners; Alerts bell | feedback is spread over banners, Alerts and the profile |
| 9. Completed | Done column; the task page offers "Record the outcome" | the prompt appears only inside a completed task |
| 10. Record a contribution | sidebar *More → Outcomes → Record a contribution* | label mismatch (Outcomes vs contribution) and the three-click path. No guidance on **when** a record is appropriate |
| 11. See my contribution | *Outcomes → "Contribution analysis →"* tab, or *Contribution Journeys* | five pages describe "my work" (Journeys, Outcomes, My contribution, My Work Analytics, Analyse My Day) |
| 12. Connect apps | *Connected Apps* and *My Work Evidence* | no plain statement up front of what is collected and what is never counted *(the pages carry such statements; their prominence at the moment of connecting was not verified)* |
| 13. Suggest a task | "Suggest a task" when permission is limited; result in *Task Requests* | the employee cannot tell why the button says Suggest |

## 3. Existing manager journey

| Step | Where it happens today | Friction found |
|---|---|---|
| 1. Arrive | `#/dashboard` = Team Workboard | no orientation; the purpose of the page is "the board" |
| 2. Understand the team | board, four numbers, attention line, contributions strip | good; but "Overview" and "Workboard" are the same page, so there is no calm summary view |
| 3. Find who needs me | attention line → filter; "N to review" link | decisions live in five places (below) |
| 4. Approve submitted work | In review column → task page → "Review submission" | fine |
| 5. Confirm priorities and deadlines | *Review Queue* | name does not say what is reviewed |
| 6. Judge analyses, evidence, whose work it is | *Contribution Reviews* | name overlaps with Review Queue |
| 7. Verify a contribution | *Outcomes* → To verify | hidden under *More* |
| 8. Decide suggestions | *Task Requests* | hidden under *More* |
| 9. Resolve evidence | *Team Intelligence* → evidence tab | third name for "team" |
| 10. Understand a person | board → owner → profile, or *Team Intelligence*, or *Work Analytics* | three team pages with overlapping people lists |
| 11. Administer | *Settings* (members, permissions, alerts, audit) | no guide for first setup |

---

## 4. Problems and confusing areas

Severity: **H** blocks understanding, **M** slows people down, **L** polish.

| # | Problem | Evidence | Sev |
|---|---|---|---|
| P1 | **Naming drift.** Sidebar label ≠ page title ≠ concept | *Work Analytics*→"Work Intelligence"; *Team Intelligence*→"Team intelligence" (a different page); *Slack Intake*→"Work from Slack"; *Analyse My Day*→"AI Work Assistant"; *Manager Copilot*→"Ask about your team"; *Connected Apps*→"Automation Center" (manager); *Outcomes*→"Outcomes & impact" (it is the contribution record) | H |
| P2 | **Five manager inboxes**, five counts | In review column; Review Queue; Contribution Reviews; Task Requests; Outcomes → To verify (+ evidence to resolve inside Team Intelligence). Sidebar badges: three different ones | H |
| P3 | **Manager sidebar overload**; employee pages repeated under "My work" | 16 links + 2; My Tasks / My Work Evidence / Analyse My Day duplicate the employee set | H |
| P4 | **No first-run guidance** for either role | no checklist, tour or orientation anywhere; Welcome handles org join/create only | H |
| P5 | **"My contribution" is scattered** | Journeys, Outcomes, My contribution profile, My Work Analytics, Analyse My Day; the profile is reachable mainly via a tab inside Outcomes | H |
| P6 | **No guidance on when to record a contribution** | form text says "a short record is fine"; nothing says routine tasks should not be recorded | H |
| P7 | **Jargon** | "L1–L4", "complexity expectation", "dimensions", "signals", "unconfirmed", "analysed", "Copilot", "journeys" | M |
| P8 | **Possible over-claim in copy.** "AI Work Assistant" is built from records by fixed rules; AI is optional and only for a write-up (header comment of the service). With AI off (production today) the title promises more than runs | `server/intelligence/assistant.js` | M |
| P9 | **Task page is very long.** About a dozen stacked sections; the employee's next action is not singled out beyond banners | `renderTaskDetail` | M |
| P10 | **Workboard affordance gap.** Looks fully draggable; only three moves work; reasons appear after the drop. Only To do has "Add a task" | by design (lifecycle rules), but unexplained | M |
| P11 | **Employee workboard lacks a path to contributions.** Nothing on the page invites recording or reading a contribution | workboard header and body | M |
| P12 | **Three overlapping team pages** for managers | Team Intelligence, Work Analytics (Work Intelligence), Contribution Reviews | M |
| P13 | **Raw errors reach users.** A stale server showed "No such API route" inside the board | seen in your screenshot | M |
| P14 | **Mobile is a shrunk desktop in places.** Four tabs differ per role; *More* opens a 16-link drawer; Work Intelligence and profile tables scroll sideways inside cards | `app.js`, styles | M |
| P15 | **Empty states are per page, not per journey.** They explain the page, not the next step in the whole product | `empty()` copy | M |
| P16 | **Surveillance perception risk.** Connected apps and "evidence" can read as monitoring unless the "never counted, only what you choose" promise is shown at the moment of connecting | *(not verified: prominence)* | M |
| P17 | **Two themes, brand colours differ from the brief.** Light is the default theme; dark tokens are `#0A0A0A / #111 / #161616 / #262626 / #EDEDED`, not `#080808 / #111 / #181818 / #303030 / #FFF` | `styles.css` tokens | L |
| P18 | **Settings first-run is unguided.** Teams, members and permissions are the manager's first job and sit in the third and fourth settings tabs | `settings.js` | L |

---

## 5. Proposed employee navigation and page structure

**Principle:** one question per item, in the order an employee thinks.

```
My Workspace      what is on my plate and what needs me now
My Tasks          every task, and suggestions I made
My Contributions  what I contributed, with evidence and how it stands
My Profile        who I am, my connected apps and my privacy
```
Secondary (not in the main list): Alerts (bell in the top bar), Help (glossary and first-run checklist), sign-out and theme in the profile menu.

| Item | Contains | Type |
|---|---|---|
| **My Workspace** | today's `#/dashboard` for employees: acceptance inbox first, then the five-column board; a quiet "Prepare my day" link (today's *Analyse my day*) | [REORG] rename + order; inbox stays |
| **My Tasks** | tabs: *Active* (today's My Tasks), *Suggestions* (today's Task Requests), *Completed* | [REORG] Task Requests becomes a tab |
| **My Contributions** | hub with tabs: *Recorded* (today's Outcomes list + "Record a contribution"), *Journeys* (today's Contribution Journeys), *My assessment* (today's "My contribution" profile), *Progress* (today's My Work Analytics) | [REORG] four existing pages become one hub; routes stay |
| **My Profile** | tabs: *About me* (settings profile), *Connected apps* (today's Connected Apps), *My evidence* (today's My Work Evidence), *Privacy* (a plain statement of what is and is not collected) | [REORG] + [NEW] Privacy text only |

**Employee guidance (all [NEW] text, no new data):**

- **How to work a task** in five lines, shown in the first-run checklist and as a "?" on the board: *Accept* → *Start* → *Update progress* → *Report a blocker if stuck* → *Submit for review*.
- **When a contribution record is appropriate.** Record one when you:
  - solved a hard problem or found a root cause,
  - prevented an incident or a risk,
  - saved time or cost that others will feel,
  - shared knowledge or something reusable,
  - unblocked or helped others.

  **Do not record** routine tasks done as assigned (they are already visible and approved), meetings, messages, hours or "busy" days. If a task already tells the story, link the task instead of repeating it; one record per outcome. Records are not points, and the number of records is never a measure.
- **Where it is shown in the product:** a one-line note on the Record form, in the first-run checklist, and as the empty state of *Recorded*.

## 6. Proposed manager navigation and page structure

```
Team Overview     what needs me today
Workboard         the team's work, by status
People            each person, their work and contribution
Reviews           every decision waiting for me, in one place
Work Intelligence the team's work, contribution and outcomes
```
Secondary (grouped under "Tools" or in the profile menu): Task Requests inside Reviews; Connected Apps; Reports; Slack Intake; Ask (Copilot); Alerts (bell); Settings; **My workspace** (the manager's own tasks, evidence and day, today's "My work" section, reachable from the profile menu).

| Item | Contains | Type |
|---|---|---|
| **Team Overview** | a calm one-screen summary: *Needs attention* (overdue, blocked, awaiting review, counts that already exist), *Waiting for you* (one line per inbox with its count, linking to the Reviews hub), *Contributions to look at* (today's strip), *Team at a glance* (the three inline metrics). No charts | [REORG] today's dashboard header, attention line and strip move here; [NEW] layout only |
| **Workboard** | today's Kanban, filters and add-task, unchanged in behaviour | [REORG] moves to its own item; all rules kept |
| **People** | alphabetical list (today's Work Intelligence people list), each row linking to the contribution profile; includes *Team Intelligence's* people data | [REORG] merges Team Intelligence people view and the Work Intelligence people list |
| **Reviews** | one hub, tabs and one badge: *Work to approve* (In review), *Contributions to verify* (Outcomes pending), *Assessments to confirm* (today's Contribution Reviews), *Priorities and deadlines* (today's Review Queue), *Task requests*, *Evidence to resolve* | [REORG] six existing pages become tabs of one hub; each keeps its route |
| **Work Intelligence** | today's page (Team, Person, Task tabs) | [IMPROVE] copy only |

---

## 7. Page-by-page specifications

Template for each page: **Purpose · Who · Do here · Status meanings · After an action · Empty state · First-timer takeaway.** *Type* shows how each differs from today.

### 7.1 Landing, sign-in and Welcome

| | |
|---|---|
| Purpose | explain KONVO in ten seconds, let people in |
| Who | anyone |
| Do here | sign in, or join an organization |
| After | straight to the role's first page; first-run checklist appears (section 8) |
| Empty (Welcome with no invitation) | "Ask your manager for an invitation or a join code" with the two inputs |
| First-timer takeaway | "KONVO makes work visible and shows contribution fairly; it is not a monitoring tool" |
| Changes | **[IMPROVE]** add the tagline and the promise ("Work moves forward. Every contribution counts.") above the sign-in card; **[NEW]** a three-line "what KONVO is / is not" on Welcome |

### 7.2 My Workspace (employee) — `#/dashboard`

| | |
|---|---|
| Purpose | see what needs me now and what I am working on |
| Do here | answer the inbox, start a task, open a task |
| Status meanings | **To do** assigned, not started. **Awaiting acceptance** you have not accepted yet; it is not progress. **In progress** you started it. **Blocked** an open blocker; shown as context, never a fault. **In review** submitted; not done until a manager approves. **Done** approved |
| After an action | the card moves; toast says what happened; the manager is notified where the existing flow does so |
| Empty | "Nothing assigned yet. When someone assigns you work it appears here. You can also suggest a task." |
| Takeaway | "I accept work, move it along, and ask for review" |
| Changes | **[REORG]** inbox above the board; **[NEW]** a one-line legend under the column titles ("What do these mean?" popover); **[IMPROVE]** explain on drag-start which moves are possible; **[NEW]** a small "Record a contribution" text link in the header (links to the form, no new logic) |

### 7.3 My Tasks and Task detail

| | |
|---|---|
| Purpose | every task I own or suggested, and the full record of one task |
| Do here | open, update progress, report or resolve a blocker, submit, comment, add evidence |
| Status meanings | as 7.2; **Declined** you said no, your manager will reassign; **Overdue** past a confirmed deadline (context, not a verdict); **At risk** little time left for the progress made |
| After an action | page refreshes in place; history shows who did what |
| Empty | "No tasks yet" with "Suggest a task" |
| Takeaway | "the next step is the highlighted one" |
| Changes | **[IMPROVE]** task detail gets a single **Next step** bar at the top (the existing primary button, labelled in plain words: "Start work", "Submit for review", "Report a blocker"); **[REORG]** group the page into four collapsible parts: *About*, *Progress and blockers*, *Review and evidence*, *History*; keep every section; **[REORG]** Task Requests become the *Suggestions* tab |

### 7.4 My Contributions (hub) and Record a contribution

| | |
|---|---|
| Purpose | show what I contributed, how it stands, and how my work was judged |
| Who | employee (own); managers see a person's through People |
| Do here | record a meaningful contribution, add evidence, correct after a review, read assessments |
| Stage meanings | **Claimed** you described it; nothing attached. **Supported** evidence is attached; no manager has looked yet. **Reviewed** a manager did not verify it and gave a reason; you can correct and resubmit. **Verified** a manager confirmed the result. Nothing is promoted automatically. Missing evidence is not the same as no contribution |
| After an action | the stage line updates; a manager is told it awaits review |
| Empty (*Recorded*) | "Nothing recorded yet. Record a contribution when you solved something that mattered. Routine tasks are already visible, so you do not need to record them." plus a two-line example |
| Takeaway | "I decide what is worth recording; value matters, not volume" |
| Changes | **[REORG]** hub with four tabs (section 5); **[NEW]** the when-to-record guidance (5.) shown at the top of *Recorded* and on the form; **[IMPROVE]** form fields keep their ids; add a one-line example under each field; **[IMPROVE]** stage line shown as four steps with the current one marked, using today's stage data |

### 7.5 My Profile

| | |
|---|---|
| Purpose | who I am, which apps I connected, what is collected |
| Do here | edit profile; connect or disconnect apps; choose what is collected; confirm or reject suggested evidence matches |
| Empty | "No apps connected. Nothing is collected until you choose it." |
| Takeaway | "I control what is collected, and activity is never counted" |
| Changes | **[REORG]** Profile, Connected Apps and My Work Evidence become tabs; **[NEW]** *Privacy* tab with a plain statement drawn from the existing data-policy wording (no new claims) |

### 7.6 Team Overview (manager)

| | |
|---|---|
| Purpose | in thirty seconds: who is on the team, what is progressing, what needs me, where the evidence is |
| Who | manager, admin |
| Do here | open a blocked or overdue task, open a review hub tab, open a person |
| Meanings | **Needs attention** overdue, blocked, or waiting for a review or decision; an unconfirmed deadline is context and is not counted |
| After an action | links open the existing destination; counts update on return |
| Empty (new team) | "Your team has no tasks yet. Add a task, or invite people first" with two buttons |
| Takeaway | "here is what needs me, and here is where to look next" |
| Changes | **[REORG]** takes the attention line, the three inline metrics and the contributions strip from today's dashboard; **[NEW]** a "Waiting for you" list with one line per inbox and its count (counts already exist); no charts |

### 7.7 Workboard (manager)

Purpose, status meanings, behaviour and rules are exactly today's board. **[REORG]** it moves to its own nav item; **[NEW]** a "What can I drag?" tip (three allowed moves, and why the rest go through the task page); empty column text stays compact.

### 7.8 People and the person profile

| | |
|---|---|
| Purpose | understand one person's work and contribution without opening several pages |
| Do here | open a name; read current work, contributions, evidence, assessments; request more context |
| Meanings | assessment status per person: *Not enough evidence yet* means nothing was assessed, never poor performance. *N to review* items wait for you. Simulated or rules-only analyses are labelled |
| After an action | profile links to the task assessment, where you verify, adjust or dispute |
| Empty | "No contributions recorded in this period. That does not mean nothing was contributed." |
| Takeaway | "story: responsibility → contribution → challenge → evidence → outcome → assessment" |
| Changes | **[REORG]** People list = alphabetical rows (today's Work Intelligence list); **[IMPROVE]** profile keeps today's order (summary, tasks and evidence, contributions, assessment, outcomes, analysed work) and adds a one-line "how to read this page" help |

### 7.9 Reviews hub

| | |
|---|---|
| Purpose | every decision only a manager can make, in one place |
| Tabs and meaning | **Work to approve**: submitted tasks; approving completes the task, it does not verify any claimed impact. **Contributions to verify**: claims waiting for confirmation. **Assessments to confirm**: AI/rules analyses awaiting your judgement; you can approve, adjust or dispute. **Priorities and deadlines**: values not confirmed yet; nothing is official until you decide. **Task requests**: suggestions; approving makes them official tasks. **Evidence to resolve**: whose work an item belongs to |
| After an action | the item leaves the list; the person is notified through the existing flow |
| Empty | "Nothing is waiting for you." (single quiet line) |
| Takeaway | "one inbox, six kinds of decision" |
| Changes | **[REORG]** existing pages become tabs, routes kept (old URLs redirect into the right tab); **[IMPROVE]** one badge on the nav item (sum of the existing counts) and per-tab counts |

### 7.10 Work Intelligence

Today's Team tab (people first, three inline metrics, compact outcomes) with Person and Task tabs. **[IMPROVE]** copy: replace "assessment" with "how the work was judged" where clear; **[IMPROVE]** make the hub's name match everywhere (nav, title, links). No structural change.

### 7.11 Connected Apps, Reports, Slack Intake, Ask, Alerts, Settings

| Page | Change |
|---|---|
| Connected Apps | **[REORG]** one name for both roles; manager-only automation parts stay manager-only |
| Reports | **[IMPROVE]** keeps the "no report ranks people by tasks closed" statement; grouped under *Tools* |
| Slack Intake | **[REORG]** nav label matches the title ("Work from Slack"); grouped under *Tools* |
| Ask (Copilot) | **[IMPROVE]** state "answers come from your team's records; nothing is invented" and that AI is off when it is; **[REORG]** nav label "Ask about your team" |
| Alerts | **[IMPROVE]** bell with count in the top bar for both roles; page unchanged |
| Settings | **[IMPROVE]** tab order follows the first-run job: *Teams and members → Employee permissions → Organization → Alerts → Audit*; **[NEW]** one-line purpose under each tab |

---

## 8. First-time onboarding flow

Delivered as a dismissible **Getting started** panel plus short contextual help. It only uses real state (no fake progress).

### Employee (shown on My Workspace until dismissed)
1. **Welcome (one screen):** "KONVO makes your work visible so it can be understood fairly. It does not count messages, hours or activity." plus your role in one line.
2. **Checklist (each item ticks from real data):**
   - Look at your workspace *(always true after first load)*.
   - Accept or start your first task *(a task of yours has left Awaiting acceptance/To do)*.
   - Know how to ask for help *(link: "Report a blocker" explained)*.
   - Submit work for review *(a submission exists)*.
   - Know when to record a contribution *(opens the guidance; ticks when read)*.
   - Optional: connect an app, with the privacy statement shown first.
3. **Contextual help:** "?" on the board columns, on stage lines, on the Record form.

### Manager (shown on Team Overview until dismissed)
1. **Welcome:** "See what your team is doing and judge contribution on evidence, not volume."
2. **Checklist (ticks from real data):**
   - Set up your team: add people and teams *(members exist)*.
   - Set employee permissions *(opened once)*.
   - Create or approve your first task *(a task exists)*.
   - Confirm a priority or deadline *(Review hub tab)*.
   - Review a submission *(a review exists)*.
   - Verify a contribution *(a verification exists)*.
   - Optional: connect Slack or other apps.
3. **Contextual help:** a short explanation at the top of Reviews, People and Work Intelligence.

**Persistence:** v1 stores "dismissed" and "read the guidance" in the browser only. Server-side persistence would need a small API and a stored flag, so it is **deferred and needs approval** (section 12).

---

## 9. Reusable design system and components

### 9.1 Visual direction
Professional, minimal, premium (Linear, Vercel, Stripe): matte black and white, thin dividers, generous whitespace, restrained radii, muted semantic colours, no gradients, no illustrations, only functional motion.

### 9.2 Tokens
| Token | Value (brief) | Today (dark) | Note |
|---|---|---|---|
| background | `#080808` | `#0A0A0A` | align |
| surface | `#111111` | `#111111` | same |
| raised / card | `#181818` | `#161616` | align |
| border | `#303030` | `#262626` | align |
| text | `#FFFFFF` | `#EDEDED` | align |
| muted text | `#A1A1AA` | `#A1A1A1` | align |
| font | Inter | Inter (self-hosted) | same |
| radius | ≤ 8px | 4–8px | same |
| spacing | 4 / 8 / 12 / 16 / 24 / 32 | same scale | same |

The existing light theme uses the same token names; the default theme is a decision (section 14).

Semantic status colours (muted, AA contrast on their fills): neutral, info, success, warning, danger, plus the stage colours (Claimed neutral, Supported info, Reviewed warning, Verified success).

### 9.3 Components
| Component | State today | Change |
|---|---|---|
| Page header (title, one-line purpose, one primary action) | present, varies | **[IMPROVE]** one pattern, max one sentence |
| Button (primary, ghost, link, small, icon) | present | keep |
| Badge / chip (status, stage, priority) | present | **[IMPROVE]** one meaning per colour, shared legend |
| Stage line (4 steps) | badge only | **[NEW]** presentation of the existing stage |
| List row (person, task, contribution) | several variants | **[REORG]** one row component; dividers instead of boxes |
| Table | several | **[IMPROVE]** use only for true tables; rows elsewhere |
| Tabs | present | keep; used for the hubs |
| Empty state | present, per page | **[IMPROVE]** compact, one next action, one example |
| Loading | present | keep |
| Error block | raw message | **[IMPROVE]** friendly text, Retry, technical detail collapsed |
| Checklist panel | none | **[NEW]** Getting started |
| Help popover / glossary | none | **[NEW]** "?" with plain definitions |
| Notice / banner | present | keep, fewer |
| Menu, modal, confirm dialog, toast, avatar, progress bar | present | keep |

### 9.4 Plain-language glossary (replace jargon)
| Today | Proposed | Where |
|---|---|---|
| Work Analytics / Work Intelligence | **Work Intelligence** everywhere | nav, titles, links |
| Team Intelligence | **People** | nav |
| Outcomes, Outcomes & impact | **Contributions** (the records) | employee and manager |
| Contribution Journeys | **Journeys** (a tab of My Contributions) | |
| Contribution Reviews + Review Queue + Task Requests | **Reviews** (tabs) | |
| Manager Copilot / AI Work Assistant / Analyse my day | **Ask about your team** (manager), **Prepare my day** (employee); never "AI" unless AI runs | |
| Slack Intake | **Work from Slack** | |
| Connected Apps / Automation Center | **Connected apps** | |
| complexity expectation, L1–L4 | **How hard the work is expected to be / was** (L1–L4 shown with a one-line meaning) | |
| dimensions | **How the work was judged** | |
| signals | **Heads-up** | |
| unconfirmed (deadline/priority) | **Not confirmed yet** | |
| analysed / assessment | **judged** / **how the work was judged** | |

---

## 10. Desktop and mobile behaviour

**Desktop (≥ 1100px):** sidebar with five role items and a small *Tools* group; content up to a wide max width; lists as full-width rows; tables only where comparison is needed.

**Tablet (820–1100px):** sidebar collapses to icons or a drawer; board shows two or three columns.

**Phone (< 820px):**
- Bottom bar of four per role, plus a *More* sheet containing the secondary tools only (not the whole sidebar).
  - Employee: Workspace, Tasks, Contributions, Profile.
  - Manager: Overview, Workboard, People, Reviews.
- Boards scroll sideways inside themselves; the page never scrolls sideways.
- Tables become stacked cards with labels (as the People list already does).
- Forms open as full-height sheets; touch targets at least 44px.
- Reviews hub tabs become a horizontally scrollable strip with counts.

---

## 11. Existing features that must be preserved

Task lifecycle and its transition rules; acceptance, decline and transfer; blocker reporting and resolution; submission and manager approval; Slack intake and acceptance; task requests and approval; priority and deadline confirmation, change requests; evidence collection, attribution and the rule that activity is never counted; assessments with every dimension, reasons, employee correction and dispute, manager approve/adjust/dispute; contribution record stages and verification; shared outcomes counted once; Work Intelligence Team, Person and Task tabs; alerts, M91, signals, weekly reports; reports; audit history; permissions and tenant isolation; the Workboard rules; Connected Apps, automations and the Advanced Builder; the Daily reflection; every existing hash route (old URLs must keep working through aliases or redirects); every API contract.

---

## 12. Prioritized implementation roadmap

Effort: S under a day, M a few days, L a week or more. No phase changes an API, schema, permission or integration unless marked ⚠.

| Phase | Work | Type | Effort | Risk |
|---|---|---|---|---|
| **0. Words** | glossary applied to nav labels, titles, buttons; friendly error text; fix "AI" naming; copy for empty states | [IMPROVE] | S | low |
| **1. Navigation** | new employee and manager sidebars, bottom bars and *Tools* group; route aliases so old URLs still work; profile-menu "My workspace" for managers | [REORG] | M | medium (routes) |
| **2. Reviews hub** | one hub with six tabs, one badge, redirects from old routes | [REORG] | M | medium |
| **3. My Contributions hub** | four tabs, when-to-record guidance, stage line | [REORG]+[NEW] | M | low |
| **4. Onboarding** | Getting started panels, "?" help, Privacy tab, landing promise | [NEW] | M | low |
| **5. Team Overview and People** | split Overview from Workboard, People list, "Waiting for you" | [REORG]+[NEW] | M | medium |
| **6. Task detail** | Next-step bar and collapsible groups | [IMPROVE] | M | low |
| **7. Visual system** | token alignment, row component, badge legend, error and empty patterns | [IMPROVE] | M–L | low |
| **8. Mobile pass** | bottom bars, *More* sheet, sheets for forms | [IMPROVE] | M | low |
| ⚠ **Later, needs approval** | server-stored onboarding progress; a read-only reviewer role for mentors or captains; a separate "why it mattered" and date field on contributions (migration) | | | |

Recommended order: 0, 1, 2, 3, then 4, 5, 6, 7, 8. Phases 0–4 deliver most of the understanding gain.

## 13. Acceptance criteria and test plan

**Comprehension (moderated tests, five people per role, no coaching):**
- A new **employee** can, within 60 seconds, say what KONVO does, find their first task, and name the next step.
- A new **employee** can say when to record a contribution and when not to.
- A new **manager** can, within 30 seconds, say who is on the team, what is progressing, what needs them and where to inspect a person's evidence.
- A manager finds every pending decision from one place.

**Functional and regression (automated):**
- Route compatibility: every existing hash route still resolves (alias or redirect).
- Navigation per role: items, order, counts and active state; managers' "My workspace".
- Permissions unchanged: existing permission and isolation tests plus the reviewer-path tests all pass; employees still get no team data.
- Browser journeys for both roles from sign-in to first review, including the contribution stages, the Reviews hub tabs and the onboarding checklist ticks from real data.
- Contribution rules: records are not points; no score, rank or leaderboard fields appear in any payload or page.
- Existing suites (unit and all browser suites) pass unchanged except for intentionally renamed labels.

**Visual and accessibility:**
- Screenshots at 1440, 820 and 390px, light and dark, for every redesigned page, with no horizontal page overflow.
- Keyboard-only use of the sidebar, tabs, board menus and dialogs; visible focus.
- Colour contrast AA for text and status colours.
- Copy check: no banned terms ("leaderboard", "top performer", "score") and consistent glossary terms.

**Measures to collect (from testing, not invented):** time to first action, wrong-turn rate, number of pages opened to judge one person, support questions per new user.

## 14. Decisions needed from you

1. **Overview vs Workboard.** Split into *Team Overview* (calm, actionable) and *Workboard* (the Kanban) as the brief lists, or keep the Workboard as the overview with a "Waiting for you" strip? *Recommendation: split.*
2. **Default theme.** Dark (matte black, as the brief) or keep light as the default with dark available? *Recommendation: dark default, light kept.*
3. **Contribution naming.** Rename *Outcomes* to *Contributions* everywhere? *Recommendation: yes.*
4. **Team Intelligence.** Merge into *People* and retire the separate nav item (route kept)? *Recommendation: yes.*
5. **Onboarding persistence.** Browser-only for v1, or approve a small server-stored flag later?
6. **Mentor or captain access.** Out of scope here; still a manager of that team with that team's edit rights. Confirm it stays deferred.
7. **Reviews hub scope.** Include *Task requests* and *Evidence to resolve* as tabs, or keep them in their current places?
8. **Landing copy.** Confirm the tagline and the "what KONVO is / is not" statement wording.

*Nothing will be implemented until you review and approve this blueprint.*
