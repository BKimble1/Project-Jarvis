import {
  briefingWindow,
  greetingFor,
  quietLine,
  type BriefingLine,
  type MorningBriefing,
} from '@/domain/briefing-shape';
import {
  absenceSentence,
  summariseConnectors,
  type PersonalConnectorInput,
} from '@/domain/data-connections';
import { describeOutcome, SIGNAL_SOURCES, type PersonalSignals } from '@/domain/personal-signals';
import { MISSION_STATE_LABELS, TERMINAL_MISSION_STATES } from '@/domain/mission';
import type { Services } from '@/server/container';
import { buildOperatingPicture, type OperatingPicture } from './operating-picture';

/**
 * The morning briefing, assembled from records and from nothing else.
 *
 * ## What it is allowed to say
 *
 * Five things, each with a source: what is on today (Outlook, when it is connected), what finished
 * while nobody was looking (mission rows), what is waiting for the owner (the operating picture's
 * next actions), where each project stands (the deterministic status engine), and what Jarvis will
 * do next if left alone (the top of its own backlog). Then one line naming what it cannot see.
 *
 * ## Why that last line matters more than the rest
 *
 * A briefing is the surface where invention is most tempting and least detectable. "You have three
 * things on today" reads identically whether it came from a calendar or from nowhere, and a reader
 * who cannot tell will eventually be misled by a system that meant well. So the connections Jarvis
 * does not have are enumerated rather than merely absent, and the briefing says so in one line
 * every time. See `domain/data-connections`.
 *
 * Now that a calendar can be connected, the same rule runs the other way. An empty day section is
 * never a claim that the day is empty: a declined permission and a failed read each contribute
 * their own sentence, and only a source that genuinely answered with nothing is allowed to be
 * quiet.
 *
 * ## Why it is not narrated by a model
 *
 * It could be, and the sentences would be nicer. But every line here is already one sentence with
 * a link, and the thing a model would add — flow — is worth less than the guarantee that no line
 * exists without a row behind it. When the mission narrator writes a project's headline it is
 * quoted, not re-written: that narration was already validated against its own evidence.
 */
export async function buildMorningBriefing(
  services: Pick<
    Services,
    | 'charterService'
    | 'operatorTicks'
    | 'workerRepo'
    | 'missionRepo'
    | 'clarifications'
    | 'permissions'
    | 'graphs'
    | 'tasks'
    | 'opportunities'
    | 'projects'
    | 'briefings'
    | 'sources'
    | 'personalSignals'
    | 'settings'
  >,
  options: { readonly now?: Date; readonly lastBriefingAt?: string | null } = {},
): Promise<MorningBriefing> {
  const now = options.now ?? new Date();
  const picture = await buildOperatingPicture(services, now);
  const { since } = briefingWindow({ now, lastBriefingAt: options.lastBriefingAt ?? null });

  const [finished, portfolio, sources, signals] = await Promise.all([
    services.missionRepo.list({ limit: 60 }),
    services.briefings.briefPortfolio(),
    services.sources.listAllGithubSources(),
    /*
     * `unread` rather than `new-since-last`, deliberately. A briefing is read more than once — the
     * dashboard renders it, the API serves it, a refresh repeats it — and the delta mode consumes
     * its own answer. Asking twice must not empty the second reply.
     */
    services.personalSignals.read({ mailMode: 'unread' }),
  ]);

  const overnight = finished.items
    .filter((mission) => {
      if (!(TERMINAL_MISSION_STATES as readonly string[]).includes(mission.state)) return false;
      const at = Date.parse(mission.updatedAt);
      return !Number.isNaN(at) && at >= since.getTime();
    })
    .slice(0, 6)
    .map<BriefingLine>((mission) => ({
      text: `${mission.title} — ${MISSION_STATE_LABELS[mission.state].toLowerCase()}${
        mission.pullRequestUrl ? ', with a draft pull request waiting' : ''
      }.`,
      href: `/missions/${mission.id}`,
    }));

  const projects = portfolio.projects.slice(0, 8).map<BriefingLine>((project) => {
    const assessment = portfolio.assessments.get(project.id);
    return {
      text: `${project.shortName ?? project.name}: ${assessment?.headline.text ?? 'not assessed yet'}`,
      href: `/projects/${project.id}`,
    };
  });

  return {
    greeting: greetingFor(now.getUTCHours()),
    headline: picture.headline,
    yourDay: dayLines(signals),
    overnight: overnight.length > 0 ? overnight : [{ text: quietLine(since, now), href: null }],
    needsYou: picture.actions.map<BriefingLine>((action) => ({
      text: `${action.label} — ${action.detail}`,
      href: action.href,
    })),
    projects,
    next: nextSentence(picture),
    notConnected: absenceSentence(
      summariseConnectors({
        repositories: {
          configured: sources.length,
          synced: sources.filter((source) => source.syncStatus === 'ok').length,
        },
        /* See the readiness check: nothing to configure until the call bridge has a provider. */
        telephonyConfigured: false,
        personal: personalInput(signals),
      }),
    ),
    at: now.toISOString(),
  };
}

/**
 * Today, in the order a person would want it.
 *
 * Appointments first because they are the only thing with a deadline attached, then overdue work,
 * then unread mail — and each one bounded, because a briefing that lists forty unread messages is
 * a briefing nobody finishes.
 *
 * A source that did not answer contributes a sentence saying so rather than nothing. That is the
 * whole discipline of this section: silence and "nothing today" have to be distinguishable, and
 * they are only distinguishable if the failure says its own name.
 */
function dayLines(signals: PersonalSignals): readonly BriefingLine[] {
  const lines: BriefingLine[] = [];

  for (const entry of signals.calendar.slice(0, 6)) {
    const when = entry.isAllDay
      ? 'All day'
      : entry.startAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const where = entry.location ? ` · ${entry.location}` : '';
    lines.push({ text: `${when} — ${entry.subject}${where}.`, href: '/connections' });
  }

  const overdue = signals.tasks.filter((task) => task.overdue).slice(0, 4);
  for (const task of overdue) {
    lines.push({ text: `Overdue: ${task.title} (${task.listName}).`, href: '/connections' });
  }

  for (const item of signals.mail.slice(0, 4)) {
    lines.push({ text: `Unread — ${item.from}: ${item.subject}.`, href: '/connections' });
  }

  /*
   * Only the sources that could not answer. A source that answered has already spoken above, and
   * repeating "Outlook calendar: 3 in the next day" under a list of three appointments is noise.
   */
  for (const source of SIGNAL_SOURCES) {
    const outcome = signals.outcomes[source];
    if (outcome.state === 'ok' || outcome.state === 'not_connected') continue;
    lines.push({ text: describeOutcome(source, outcome), href: '/connections' });
  }

  return lines;
}

/** What the connector summary should say about mail, calendar and tasks after this read. */
function personalInput(signals: PersonalSignals): PersonalConnectorInput {
  const everyOutcome = SIGNAL_SOURCES.map((source) => signals.outcomes[source]);
  return everyOutcome.every((outcome) => outcome.state === 'not_connected')
    ? { kind: 'unavailable' }
    : { kind: 'read', outcomes: signals.outcomes };
}

/**
 * What happens if the owner does nothing.
 *
 * Answered from authority rather than from the backlog alone, because the same queue means two
 * completely different things depending on the mode: under standing authority Jarvis will start
 * the top of it, and in every other mode it will propose it and wait. Saying "Jarvis will work on
 * X" when it is going to sit there proposing X is the sort of small lie that costs a whole day.
 */
function nextSentence(picture: OperatingPicture): string {
  if (!picture.workerReady) {
    return 'Nothing will run until a worker is connected.';
  }
  if (!picture.standingAuthority) {
    return picture.blockedReason
      ? `Jarvis will not start anything by itself. ${picture.blockedReason}`
      : 'Jarvis will propose work and wait for you rather than starting anything.';
  }
  const first = picture.actions.find((action) => action.kind === 'start_opportunity');
  if (!first) return 'Jarvis has nothing queued that it would start on its own.';
  return `Left alone, Jarvis will start: ${first.label}.`;
}
