# Talking to Jarvis

What changed, what you can say, what happens when you say it, and — the part that matters most —
what still does not work.

Read the last section first if you only read one.

---

## The three things to try

### 1. Talk about an idea

> **You:** I have an idea for an app that tracks rent across my flats.

Jarvis says it is thinking, and asks your worker to judge it — on **your Claude subscription**, in
the runtime the worker already runs. A moment later the assessment appears: who would use it, the
problem it solves, whether it looks worth building, the smallest useful V1, what is being assumed,
and only the questions that would change that V1.

**Nothing is created** while any of that happens. No project, no repository, no mission. Then:

> **You:** Go ahead.

_Now_ it makes the project, a **private** repository, sets the goal, and starts planning. The
proposal it is agreeing to is the one that was on your screen — if you say "go ahead" ten minutes
later with nothing on offer, it says so rather than guessing.

Asking whether something is worth building never builds it. "Is this worth building?", "Should I
build a rent tracker?", "What do you think about a small invoicing app?" are all read as questions,
because they are.

### 2. A read-only audit of something that exists

> **You:** Audit Holograph read-only. Inspect the repository and report what is implemented, the
> main visible blockers, and the three most useful next actions.

This is the sentence that caused most of this work. It used to be answered as a question about
blocked projects — an unanchored `blockers?` pattern matched three-quarters of the way through a
sentence that opens with two imperative verbs — and the workaround was to learn the magic phrasing
"Generate a read-only audit report". Both now reach the same place, so there is no phrasing to know.

It starts a read-only mission on Holograph. Read-only is not cosmetic: the mission asks the charter
for no branch and no write scope, so it can be authorised on terms a build could not.

### 3. Something new

> **You:** Build me a simple rent tracker app.

Project, private repository, goal, mission — from one sentence, with no screens. Say it twice and
you get one repository, not two.

### And the everyday ones

| You say                                          | What happens                                                               |
| ------------------------------------------------ | -------------------------------------------------------------------------- |
| "How is Holograph coming?"                       | Answered from evidence. Nothing changes.                                   |
| "What have you been working on?"                 | Answered. Nothing changes.                                                 |
| "Focus on CoreCredit today."                     | Shows where CoreCredit stands and what it needs. Invents no work.          |
| "Remember that I have classes tomorrow morning." | Kept as a memory you said.                                                 |
| "Don't build it yet."                            | Nothing starts. Negation wins over the verb it negates.                    |
| "Slow down until my Claude allowance resets."    | **Recognised, not yet applied.** See the honest limits.                    |
| "The second one."                                | The second thing _you were looking at_, by id — or it says the list moved. |
| "Pause." / "Stop."                               | Mission control, on work that already exists.                              |

Speaking works the same way. The transcript is still read back to you before anything happens,
because a browser hears "delete the old branch" as "delete the whole branch" often enough to
matter — but reading back what was heard is a misrecognition check, not a request for permission.

**Voice still cannot approve anything.** "Approve it", "merge it", "ship it", "deploy" spoken out
loud are refused and always will be. Approving is agreeing to a specific plan, merge or release that
already exists, and that happens on screen where you can see what you are agreeing to.

---

## What is actually running

One interpreter, one path.

```
what you say  →  interpretMessage()  →  work?      →  mission  →  charter  →  worker
                 (src/domain/          question?   →  status router
                  interpretation.ts)   idea?       →  a proposal, and nothing else
                                       follow-up?  →  what was on your screen
                                       memory?     →  the memory service
```

Before this there were four things deciding whether a sentence was work — the query parser, the
mission intake classifier, the voice transcript classifier, and the reply-intent reader — and they
disagreed. There is now one, and the other three either call it or do a narrower job (`parseQuery`
still decides _which_ question a question is; `interpretReply` still binds an ordinal to a list).

### Standing authority

You authorised ordinary development without per-item approval, and the code now does that rather
than hiding the buttons. A mission you asked for is offered to the charter by the operating loop
exactly as one Jarvis raised itself; the charter decides. If it grants what the plan needs, the work
proceeds without you. If it does not, the mission waits for you at the plan — that is the charter's
own design, not a special case, and Jarvis says which happened.

`src/server/operator/operator-service.ts` — `advanceRequestedWork`.

### Creating repositories

A third GitHub credential, `GITHUB_PROVISION_TOKEN`, separate from the read token and from the
worker's push token. Leave it unset and Jarvis makes the project and tells you plainly that there is
no repository — it does not invent a URL.

Four things it can do with that token: look a repository up, create one for you, create one in an
organisation, and ask who the token belongs to. There is no code here that deletes, renames, pushes
or changes visibility, and `tests/integration/entities-and-security.test.ts` asserts the absence
rather than trusting it. Every repository it creates is `private: true`, written at the call to
GitHub rather than taken from an argument, so there is no parameter a caller could pass to get a
public one.

Running the sequence twice makes one repository. If GitHub succeeds and the database write after it
fails, the retry adopts the repository rather than making `rent-tracker-2`.

### The guard in front of it

Creating a repository is the only outward-visible thing here that reverting a commit cannot undo, so
the test for "does this sentence describe something new?" is narrow on purpose. All three must hold:
a creation verb, a noun for a thing that gets made, and no phrase placing the work inside something
that already exists. "Fix the login bug" with nothing matching asks which project. It does not make
one called "login bug".

`src/domain/new-project.ts`.

---

## Setting it up

```
GITHUB_PROVISION_TOKEN=          # optional; without it, no repositories are created
GITHUB_PROVISION_OWNER=          # optional; blank means your own account
```

A fine-grained personal access token with **Administration: Read and write** (this is the permission
that creates a repository) and **Contents: Read-only**, scoped to _All repositories_ — a repository
that does not exist yet cannot be picked from a list, which is the one real cost of the feature.

The token never reaches a coding agent: it is in `WORKER_ONLY_SECRETS`, so it is stripped from every
child process the worker starts, by name and again by shape.

Launch is unchanged — see `docs/LAUNCH.md`.

---

## Honest limits

Things that are **not** done, stated plainly so you find out here rather than at the keyboard.

**Pace is recognised but not applied.** "Slow down until my Claude allowance resets" is understood,
and Jarvis says what it understood — but nothing changes the number of missions it will start. The
concurrency limit is configuration and the operating mode is a stored switch, and this sentence
changes neither yet. Set them on the operations screen and they take effect immediately. Saying "I
have slowed down" while every mission slot stayed open would be exactly the kind of thing that makes
the rest of what Jarvis says untrustworthy, so it does not say it.

**Evaluating an idea is reasoned, not researched.** The judgement is a real one — a Claude turn on
your subscription, run by your worker — but it has no internet, no market data and no competitor
list. It reasons from what you said and says so in as many words, every time. Anything more
confident would be invented.

**Thinking needs the worker running.** The dashboard holds no Claude credential and never will; the
subscription lives on the worker. So if the worker is not running, Jarvis says exactly that instead
of judging the idea — and keeps the question, so starting the worker finishes the thought without
you asking again. The same is true when your five-hour window is full: it names the window, keeps
the question, and answers when there is room. There is no `ANTHROPIC_API_KEY` anywhere in this
path, and you should not set one for it.

**Naming is a guess, and a shallow one.** "Build me a simple rent tracker app" becomes
`Rent Tracker` / `rent-tracker`. It is a word-list heuristic. Rename the project on its screen if it
guesses badly; the repository keeps the name it was created with.

**Repository creation is untested against real GitHub from here.** Every path is covered by tests
with GitHub replaced. The first real one will be the first real one.

**The desktop is not controlled.** Jarvis has a shell where the worker runs. That is not the same as
driving Windows applications, and nothing here claims otherwise.

**Project updates spoken out loud are still handed back to the screen.** Blockers, decisions and
dates change a project's own record, and there is a screen where that change is visible beside what
it replaces. Nothing in the instruction that produced this work was about that path.

---

## Where things live

|                                         |                                                   |
| --------------------------------------- | ------------------------------------------------- |
| The one interpreter                     | `src/domain/interpretation.ts`                    |
| Is this something new?                  | `src/domain/new-project.ts`                       |
| Repository names                        | `src/domain/repository-name.ts`                   |
| The conversational front door           | `src/server/conversation/conversation-service.ts` |
| Project + repository + goal             | `src/server/services/project-provisioning.ts`     |
| The only writing GitHub client          | `src/server/providers/github/provisioner.ts`      |
| Standing authority on your own missions | `src/server/operator/operator-service.ts`         |
| The endpoint the dashboard calls        | `src/app/api/conversation/route.ts`               |
| The three morning tests                 | `tests/integration/morning.test.ts`               |
