# Playbooks

A playbook is a reusable definition of how a _kind_ of mission is carried out: which agents, in
what order, with what permissions, what must be reviewed, and what counts as done.

## Why they exist

Without them, every mission's task graph is worked out from its plan. That is fine, and it stays
the default. But the same shapes recur — "add a feature", "work out why this is broken", "audit
this repository" — and rediscovering the shape each time means rediscovering the _safety_ each
time too. A playbook fixes the shape once, validates it once, and versions it so a change to it
cannot alter a mission already following it.

## The built-ins

| Key                   | For                                    | Writes | Repair rounds |
| --------------------- | -------------------------------------- | ------ | ------------- |
| `software_feature`    | Adding a feature to a repository       | Yes    | 2             |
| `bug_investigation`   | Finding and fixing a defect            | Yes    | 2             |
| `repository_audit`    | Reading a repository and reporting     | No     | 0             |
| `research_report`     | Answering a question with sources      | No     | 0             |
| `website_feature`     | A change to a website                  | Yes    | 2             |
| `ios_feature`         | A change to an iOS app                 | Yes    | 2             |
| `testflight_build`    | A TestFlight build, with your approval | No     | 0             |
| `new_project_starter` | Standing up a new project              | Yes    | 1             |
| `report_artifact`     | Producing a written artifact           | No     | 0             |

`repository_audit` and `research_report` open with several genuinely parallel read-only tasks,
which is the clearest demonstration of what the graph buys: three agents reading different parts
of a repository at once, none of which can write.

## Versioning

Installing a playbook whose content differs from the stored one creates version _n+1_. It never
mutates version _n_. A mission pins the version it was approved against, so:

- editing a playbook does not change a mission that is already running;
- switching a playbook off stops it being offered for _new_ missions and does not stop a mission
  already following it;
- a version is identified by a fingerprint of its material content, so re-installing an identical
  definition is a no-op rather than a new version.

The built-ins are seeded on first read. Seeding twice adds nothing.

## What an agent may do with a playbook

**Recommend one.** That is all.

There is no worker-authenticated route that installs, edits, enables or disables a playbook, and
the guarantee is that the route does not exist rather than that a route checks a flag. An agent
also cannot change a playbook's security requirements, because it cannot change a playbook at all.

## Writing one

A playbook is a JSON definition installed through `POST /api/playbooks` with an owner session.
`validatePlaybook` runs on install and again whenever a graph is instantiated from it, and it
refuses eleven classes of mistake (see `MULTI_AGENT_RULES.md`). The ones worth knowing before you
start:

- A playbook that writes **must** include a review task. There is no flag to skip it.
- A task may not name a permission profile wider than its role's ceiling.
- A playbook that claims it can dispatch an external build must include a release review.
- Repair rounds are clamped to the absolute ceiling regardless of what the definition asks for.

Tasks may be conditional (`if_repository`, `if_writes`, `if_web_research`), which is how one
definition serves a project with a repository and one without. A condition that is not met drops
the task and every dependency on it is rewritten, so the result is still a valid graph.

`GET /api/playbooks/<key>` returns the current version and the version history, which is the
easiest way to keep a playbook in git alongside the project it is for.
