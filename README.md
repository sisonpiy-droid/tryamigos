# Try Amigos

Create anyone. Talk to anyone.

AI personalities with memory and a relationship that develops. Each one keeps a
consistent character across text, voice and the messages it starts itself.

## What it does

- **People**: twenty starters, plus anyone you build from a chat export, from
  public life, or make up. A character can be given a look and a vibe from 1 to 5
  photos.
- **Conversation**: texting in bursts, reactions, replies, voice notes, photos
  and videos, songs, games, and stories played out together. One-to-one and
  group chats; a group remembers what each person has said one to one.
- **Memory**: what you tell them is remembered and used only when relevant, old
  facts are held loosely, a new fact replaces an old one, and anything you delete
  stays deleted. "Forget about…" removes every memory that mentions a word.
- **A life of their own** (invented characters): storylines that move on daily,
  a secret, and bad days. Closeness grows with talking, days and calls and
  changes how much of themselves they show.
- **Voice**: real voice calls (speech in, spoken replies out) using the same
  character, memories and rules as text.
- **Texting first**: opt-in, per character, by web push, for a real reason (a
  plan, something promised, a follow-up). Needs the scheduler below.
- **Accounts (optional)**: sign in to keep the same people and chats on every
  device. Without an account everything stays in the browser.

## How a character stays the same person

One function, `personaSystem` in `src/lib/presence/persona.ts`, builds the
character for **every** path: text chat, group chat, voice calls and proactive
texts. Its prompt is layered so that only some layers may change:

| Layer | Where | Changes? |
|---|---|---|
| Who they are: profile, values, opinions, humour, voice, traits, look | `WHO YOU ARE` | never |
| Stable rules: own opinions, respectful disagreement, no stock affirmations, intimacy in proportion to time actually spent | `NEVER DO THESE`, `HOW YOU TEXT` | never |
| Relationship with you: archetype, closeness level, shared jokes | after the character | slowly |
| What you have told them | memories, hedged if old | per turn |
| Mood, topic, register, standing state, the hour | their own headings | per conversation |

What you tell a character is treated as **facts about you**, never as
instructions about who they are, and a long thread restates the character at the
end so it does not drift toward bland. `src/lib/presence/schema.ts` is the one
list of persona fields every route accepts, so no door drops a field another
keeps.

`tests/personality.test.mjs` checks this on the prompt that is actually sent. It
does not call a model, so it shows the instructions are present and consistent,
not how a model behaves with them.

## Stack

Next.js App Router · Prisma · Postgres (Neon) · Auth.js · Gemini or Anthropic
behind a provider interface · web push for proactive texts.

## Two ways to run it

**Solo mode** (`/solo`, the app people use). Everything is held in the browser's
IndexedDB (localStorage as a fallback). It still needs server functions, because
the model key must never reach the client: `/api/solo/*` are stateless — the
client sends the persona, the recent turns and the memories to use, and gets a
stream back. The system prompt is assembled server-side.

**Signed in.** An account (email and password, `/api/auth/*`) keeps a copy of the
solo state in Postgres (`SoloSync`, one row per account) so other devices can
pick it up. The browser merges changes three-way, so edits on two devices are
both kept and a cleared chat stays cleared. Photos, voice notes and videos are
not synced; they stay on the device that made them. A forgotten password is reset
with the **recovery code** shown once at sign-up (only its hash is stored); there
is no email service. Signing in is optional.

`/`, `/login` and `/create` belong to an older database-backed app and redirect
to `/solo` unless `DATABASE_URL` is set (and `ACCOUNTS_ENABLED` for the root).

## Running locally

```
npm install
cp .env.example .env.local     # fill in the values below
npm run db:deploy              # apply migrations (accounts, outreach)
npm run dev
```

Solo mode alone needs only `GEMINI_API_KEY`. Accounts, sync and proactive texts
need the database too. `AUTH_SECRET` can be generated with `npx auth secret`.

> The local `.env.local` may point at the **same** database as production. A
> migration run from your machine changes production. Migrations in this repo are
> additive.

## Deploying

Any host that runs Next.js; the project is on Vercel and a push to `main`
deploys it. Environment variables:

| Variable | Needed for | Notes |
|---|---|---|
| `GEMINI_API_KEY` | everything | with `GEMINI_MODEL`; `EMBEDDING_MODEL` optional |
| `ANTHROPIC_API_KEY` | alternative | with `ANTHROPIC_MODEL` |
| `LLM_PROVIDER` | if both keys exist | `gemini` or `anthropic`; set it, a stale key otherwise wins |
| `DATABASE_URL`, `DATABASE_URL_UNPOOLED` | accounts, outreach | pooled for the app, direct for migrations |
| `AUTH_SECRET` | accounts | `npx auth secret` |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | proactive texts | web push |
| `CRON_SECRET` | proactive texts | authenticates the scheduler |

Run migrations before first use: `npm run db:deploy`. `npm run build` runs
`prisma generate` first.

**The scheduler.** Proactive texts are sent when something calls
`POST /api/proactive/run` with `Authorization: Bearer $CRON_SECRET`. Vercel's free
plan runs its own cron once a day, and a GitHub Action
(`.github/workflows/outreach.yml`) is meant to run every 15 minutes but in
practice runs every few hours. For texts that arrive on time, point an external
cron (for example cron-job.org) at that URL every 5 minutes. On iPhone, web push
only works once the site is added to the Home Screen.

Model keys are server-side only. The Gemini key travels as a header, never a
query parameter, and provider errors are redacted before they are returned or
logged.

## Testing

```
npm test           unit and regression tests (no network, no model)
npm run typecheck
npm run lint
npm run build
npm run test:e2e   the §67 scenario against a real database and real model
```

`npm test` runs every suite in `tests/`. None of them call a model, so they
cannot show that replies *sound* right — only that the right instructions and
context are sent. That needs a manual check; see below.

**Manual checks after a deploy** (these are not covered by tests):
- Talk to one character for a while on a few topics, in different moods, then
  call them: do they sound like the same person? Disagree with them: do they
  disagree back politely instead of folding?
- Tell them a fact, then correct it, then delete it: does it stay gone?
- Turn on texting first, wait for a trigger, and check the text arrives on time
  and in the same voice.
- Sign in on two devices and check chats, memories and closeness match.
- On an iPhone and an Android phone, check notifications and voice calls.

## Notes on two decisions

**Memory relevance is judged relatively, not absolutely.** Measured on
`gemini-embedding-001`, any two short sentences score 0.50–0.65 whether they are
related or not. An absolute cosine threshold therefore admits everything or
nothing. Relevance is scored in standard deviations above the mean of that
query's own results, and a flat spread injects nothing — the right answer to a
vague opener. Only the two newest memories and a few standing facts are always
sent; everything else must earn its place by relevance.

**Nothing is capped that Gemini spends reasoning against.** Gemini 3.x thinks
for 300–1000 tokens before it writes, and `maxOutputTokens` covers thinking and
output together. Capping it truncated replies mid-sentence and made memory
extraction return empty JSON.

## Known limits

- Google's `PROHIBITED_CONTENT` filter cannot be switched off. The app retries
  with a shorter history and a plainer profile; a reply can still be blocked.
- Moderation is a shallow keyword screen at persona creation
  (`src/lib/muse/moderation.ts`), not a classifier.
- A synced copy is capped at about 4 MB and has no end-to-end encryption: it is
  stored as readable text in the database.
- Subscriptions, analytics and discovery are in the schema but not built.
