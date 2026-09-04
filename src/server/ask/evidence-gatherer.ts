import type { AnswerCoverage, CitationKind } from '@/domain/answer';
import { citationHref } from '@/domain/answer';
import type { AnswerEvidenceItem, AnswerEvidenceSnapshot } from '@/domain/answer-run';
import { assertEvidenceItemIsInert, freezeEvidence } from '@/domain/answer-run';
import type { ScopeDecision } from '@/domain/conversation';
import type { RoutingDecision } from '@/domain/question-routing';
import type { Project } from '@/domain/project';
import type { ProjectAssessment } from '@/domain/status';
import {
  RANKING_VERSION,
  RETRIEVAL_API_VERSION,
  RETRIEVAL_LIMITS,
  buildScopeFilter,
} from '@/domain/retrieval';
import type { ConflictRepository } from '@/server/repositories/knowledge-types';
import type { AttentionService } from '@/server/services/attention-service';
import type { BriefingService } from '@/server/services/briefing-service';
import type { RetrievalService } from '@/server/knowledge/retrieval-service';
import type { MissionRepository } from '@/server/repositories/mission-types';
import type { ProjectRepository } from '@/server/repositories/types';

/**
 * Gathering what an answer is allowed to see.
 *
 * ## The division of labour, and why it is not negotiable
 *
 * **Structured questions are answered from structured records.** Project status comes from
 * `assessProject` through `BriefingService` — the deterministic engine that reads real repository
 * evidence — and never from retrieving prose that happens to discuss the project. A model asked
 * to infer "is CoreCredit blocked?" from documents produces a fluent answer that is wrong the
 * moment the documents are stale, and looks exactly like a right one. The engine already knows.
 *
 * **Document questions go through the Phase 4B retrieval contract and nothing else.** No SQL
 * against knowledge tables, no repository reached around. That contract applies the scope filter
 * inside the same statement that ranks, so an unauthorised chunk is never a candidate rather than
 * being fetched and discarded — and reaching around it would silently give that up.
 *
 * ## Authorization is upstream of everything here
 *
 * This module receives a `ScopeDecision` that was already resolved from the conversation's stored
 * scope against the owner's real project list. It never widens it, never consults the question
 * about which projects to read, and passes it to every source it touches. A hostile document
 * cannot change what gets gathered, because by the time any document text exists the set of
 * projects is already fixed.
 */

export interface EvidenceGathererOptions {
  readonly projects: ProjectRepository;
  readonly briefings: BriefingService;
  readonly attention: AttentionService;
  readonly missions: MissionRepository;
  readonly retrieval: RetrievalService;
  /**
   * Open disagreements between the owner's own notes.
   *
   * Two notes that contradict each other are both `active` — Jarvis does not pick a winner — so
   * without this an answer would state both as settled fact and sound most confident exactly
   * where it should sound least. A conflicted note is presented as conflicted.
   */
  readonly conflicts: ConflictRepository;
}

export interface GatherRequest {
  readonly question: string;
  readonly scope: ScopeDecision;
  readonly routing: RoutingDecision;
  readonly ownerId: string;
}

export interface GatherResult {
  readonly snapshot: AnswerEvidenceSnapshot;
  readonly coverage: AnswerCoverage;
  readonly assessments: ReadonlyMap<string, ProjectAssessment>;
  readonly projects: readonly Project[];
  readonly retrievalMode: string;
  readonly retrievalDegraded: boolean;
}

export class EvidenceGatherer {
  constructor(private readonly options: EvidenceGathererOptions) {}

  async gather(request: GatherRequest): Promise<GatherResult> {
    const items: AnswerEvidenceItem[] = [];
    const gaps: string[] = [];

    const projects = await this.scopedProjects(request.scope);
    const byId = new Map(projects.map((project) => [project.id, project]));

    let assessments: ReadonlyMap<string, ProjectAssessment> = new Map();
    let evidenceConsidered = 0;
    let missionsConsidered = 0;

    /* ------------------------------------------------ structured status */

    if (request.routing.needsStatus && projects.length > 0) {
      assessments = await this.options.briefings.assessMany(projects.map((p) => p.id));

      for (const project of projects) {
        const assessment = assessments.get(project.id);
        if (!assessment) {
          gaps.push(`${project.name} has no assessment yet.`);
          continue;
        }
        items.push(...statusItems(project, assessment));
        if (assessment.freshness.state === 'stale' || assessment.freshness.state === 'failing') {
          gaps.push(`${project.name}: ${assessment.freshness.explanation}`);
        }
      }
    }

    /* -------------------------------------------- repository evidence */

    if (request.routing.needsEvidence) {
      for (const project of projects) {
        const rows = await this.options.briefings.loadEvidence(project.id);
        evidenceConsidered += rows.length;
        /*
         * The assessment already names the evidence that mattered. Including those rows rather
         * than the most recent ones means the packet carries what the engine actually relied on,
         * so a claim citing evidence is citing something the engine also used.
         */
        const keyIds = new Set(assessments.get(project.id)?.keyEvidenceIds ?? []);
        const chosen = rows.filter((row) => keyIds.has(row.id)).slice(0, 12);
        for (const row of chosen) {
          items.push({
            ref: `evidence:${row.id}`,
            kind: 'evidence',
            origin: 'project_evidence',
            subjectId: row.id,
            label: `${project.name}: ${row.title}`,
            excerpt: [row.title, row.summary ?? ''].filter(Boolean).join(' — '),
            projectId: project.id,
            locator: row.observedAt,
            revisionId: null,
            contentHash: null,
            href: citationHref({ kind: 'evidence', id: row.id, projectId: project.id }),
            staleSince: null,
            trust: 'repository_evidence',
          });
        }
      }
    }

    /* ---------------------------------------------------- missions */

    if (request.routing.needsMissions && projects.length > 0) {
      const page = await this.options.missions.list({ limit: 60 });
      const scoped = page.items.filter((mission) => byId.has(mission.projectId ?? ''));
      missionsConsidered = scoped.length;
      for (const mission of scoped.slice(0, 20)) {
        items.push({
          ref: `mission:${mission.id}`,
          kind: 'mission',
          origin: 'mission',
          subjectId: mission.id,
          label: mission.title,
          excerpt: [
            `State: ${mission.state}.`,
            `Risk: ${mission.riskLevel}.`,
            mission.description ? `What it is: ${mission.description}` : '',
            mission.pullRequestUrl ? 'A pull request was opened.' : '',
          ]
            .filter(Boolean)
            .join(' '),
          projectId: mission.projectId,
          locator: mission.state,
          revisionId: null,
          contentHash: null,
          href: citationHref({ kind: 'mission', id: mission.id }),
          staleSince: null,
          trust: 'recorded',
        });
      }
    }

    /* -------------------------------------- knowledge and memories */

    let retrievalMode = 'unavailable';
    let retrievalDegraded = false;
    let knowledgeConsidered = 0;
    let sourcesConsidered = 0;

    if (request.routing.needsKnowledge || request.routing.needsMemories) {
      /*
       * The audience is `owner` and it is not a request field. `buildScopeFilter` clamps the
       * sensitivity ceiling by audience, so this is also what keeps private material out of any
       * future non-owner caller without that caller having to remember.
       */
      const scopes: ('global' | 'project')[] = ['global'];
      if (request.scope.projectIds.length > 0) scopes.push('project');

      const filter = buildScopeFilter({
        audience: 'owner',
        scopes,
        projectIds: [...request.scope.projectIds],
      });

      const result = await this.options.retrieval.retrieve({
        query: request.question,
        scope: filter,
        purpose: 'answer',
        limit: RETRIEVAL_LIMITS.defaultLimit,
        charBudget: 10_000,
        sourceKinds: null,
        includeSources: request.routing.needsKnowledge,
        includeMemories: request.routing.needsMemories,
        asOf: null,
      });

      retrievalMode = result.diagnostics.mode;
      retrievalDegraded =
        result.diagnostics.mode === 'hybrid_degraded' || result.diagnostics.mode === 'indexing';

      /*
       * Fetched once, and only when memories could be in the packet. Open conflicts are a small
       * set by construction — they are questions waiting for the owner — so this is a list rather
       * than a per-item lookup.
       */
      const conflicted = new Map<string, string>();
      if (request.routing.needsMemories) {
        for (const conflict of await this.options.conflicts.list('open')) {
          conflicted.set(conflict.leftId, conflict.summary);
          if (conflict.rightId) conflicted.set(conflict.rightId, conflict.summary);
        }
      }

      for (const evidence of result.evidence) {
        const isMemory = evidence.kind === 'memory';
        if (isMemory) knowledgeConsidered += 1;
        else sourcesConsidered += 1;

        /*
         * Carried in the excerpt rather than in a flag, because the excerpt is what reaches a
         * model and what a person reads. A flag would have to be remembered by every renderer;
         * this cannot be dropped by forgetting to look at it.
         */
        const conflict = isMemory ? conflicted.get(evidence.id) : undefined;
        if (conflict) gaps.push(`Two of your notes disagree: ${conflict}`);

        items.push({
          ref: `${isMemory ? 'knowledge' : 'source'}:${evidence.id}`,
          kind: isMemory ? 'knowledge' : 'source',
          origin: isMemory ? 'memory' : 'knowledge_source',
          subjectId: evidence.id,
          label: conflict ? `${evidence.title} (disputed)` : evidence.title,
          excerpt: conflict
            ? `${evidence.excerpt}\n\n[Jarvis has a conflicting note about this and has not settled it: ${conflict}]`
            : evidence.excerpt,
          projectId: evidence.projectId,
          locator: evidence.citation.locator,
          /* Pinning the revision is what stops a later refresh rewriting an old answer's basis. */
          revisionId: evidence.citation.revisionId,
          contentHash: evidence.contentHash,
          href: evidence.citation.href,
          staleSince: evidence.staleSince,
          trust: evidence.trust,
        });
      }

      /*
       * Nothing matched, said out loud.
       *
       * A question about a document that produces only project status looks like an answer, and
       * the absence is the part that matters — "Jarvis has no document about this" and "Jarvis
       * has one and it says nothing useful" call for opposite responses from the owner.
       */
      if (request.routing.needsKnowledge && sourcesConsidered === 0) {
        gaps.push('No document or note in scope matches this question.');
      }
      if (request.routing.needsMemories && knowledgeConsidered === 0) {
        gaps.push('No note you have confirmed matches this question.');
      }
      if (result.diagnostics.mode === 'lexical_only') {
        gaps.push('Search used the text index only; no semantic index is configured.');
      }
      if (result.diagnostics.truncatedByCharBudget) {
        gaps.push('More documents matched than fitted in this answer.');
      }
    }

    /*
     * A shape check on every item before it can reach a prompt. It cannot fail today, which is
     * the point: it fails the moment somebody adds a field to the evidence type through which
     * retrieved content could act.
     */
    for (const item of items) assertEvidenceItemIsInert(item);

    const snapshot = freezeEvidence({
      items,
      projectIds: request.scope.projectIds,
      retrievalMode,
      retrievalApiVersion: RETRIEVAL_API_VERSION,
      rankingVersion: RANKING_VERSION,
      gaps,
    });

    return {
      snapshot,
      coverage: {
        projectsConsidered: projects.length,
        evidenceConsidered,
        missionsConsidered,
        knowledgeConsidered,
        sourcesConsidered,
        truncated: snapshot.truncated,
        gaps: snapshot.gaps,
      },
      assessments,
      projects,
      retrievalMode,
      retrievalDegraded,
    };
  }

  /**
   * The projects this turn may read, fetched by id.
   *
   * Deliberately not "list everything and filter": the scope decision already enumerated exactly
   * which ids are permitted, and fetching only those means a project added between the scope
   * resolution and this call cannot appear in the answer.
   */
  private async scopedProjects(scope: ScopeDecision): Promise<readonly Project[]> {
    if (scope.projectIds.length === 0) return [];
    const found = await Promise.all(
      scope.projectIds.map((id) => this.options.projects.findById(id)),
    );
    return found.filter((project): project is Project => project !== null);
  }
}

/**
 * Turn one assessment into citable evidence.
 *
 * Each piece is a separate item with its own reference, so a claim can cite the blocker rather
 * than citing "the project" — a citation that resolves to a specific finding is checkable, and
 * one that resolves to a whole project is decoration.
 */
function statusItems(project: Project, assessment: ProjectAssessment): AnswerEvidenceItem[] {
  const items: AnswerEvidenceItem[] = [];

  const base = (suffix: string, kind: CitationKind = 'project') => ({
    kind,
    origin: 'status_engine' as const,
    subjectId: project.id,
    projectId: project.id,
    revisionId: null,
    contentHash: null,
    href: citationHref({ kind, id: project.id, projectId: project.id }),
    staleSince: null,
    trust: 'recorded',
    locator: suffix,
  });

  items.push({
    ...base('status'),
    ref: `project:${project.id}`,
    label: `${project.name} — current status`,
    excerpt: [
      `Status: ${assessment.status} (${assessment.statusProvenance}).`,
      assessment.phase ? `Phase: ${assessment.phase}.` : '',
      `Headline: ${assessment.headline.text}`,
      `Freshness: ${assessment.freshness.explanation}`,
      assessment.needsAttention ? 'This project needs attention.' : '',
    ]
      .filter(Boolean)
      .join(' '),
  });

  for (const [index, reason] of assessment.attention.entries()) {
    items.push({
      ...base(`attention/${reason.code}`),
      ref: `project:${project.id}#attention-${index}`,
      label: `${project.name} — ${reason.code.replace(/_/g, ' ')}`,
      excerpt: `${reason.summary} (severity ${reason.severity}, rule ${reason.rule})`,
    });
  }

  for (const [index, claim] of assessment.activeBlockers.entries()) {
    items.push({
      ...base(`blocker/${index}`),
      ref: `project:${project.id}#blocker-${index}`,
      label: `${project.name} — blocker`,
      excerpt: claim.text,
    });
  }

  for (const [index, claim] of assessment.decisionsNeeded.entries()) {
    items.push({
      ...base(`decision/${index}`),
      ref: `project:${project.id}#decision-${index}`,
      label: `${project.name} — needs your decision`,
      excerpt: claim.text,
    });
  }

  for (const [index, claim] of assessment.currentWork.entries()) {
    items.push({
      ...base(`work/${index}`),
      ref: `project:${project.id}#work-${index}`,
      label: `${project.name} — in progress`,
      excerpt: claim.text,
    });
  }

  for (const [index, claim] of assessment.recentlyCompleted.entries()) {
    items.push({
      ...base(`done/${index}`),
      ref: `project:${project.id}#done-${index}`,
      label: `${project.name} — recently completed`,
      excerpt: claim.text,
    });
  }

  /*
   * Unknowns are evidence too, and the most easily lost kind. A model that is never shown what
   * Jarvis does not know will fill the gap from its own priors rather than reporting it.
   */
  for (const [index, unknown] of assessment.unknowns.entries()) {
    items.push({
      ...base(`unknown/${index}`),
      ref: `project:${project.id}#unknown-${index}`,
      label: `${project.name} — not known`,
      excerpt: unknown,
    });
  }

  return items;
}
