import type { Evidence } from '@/domain/evidence';
import type {
  BriefingNarrative,
  PortfolioAssessment,
  PortfolioNarrative,
  ProjectAssessment,
} from '@/domain/status';
import type { Project } from '@/domain/project';

/** Exactly what a narrator is allowed to see. No credentials, no environment, no raw payloads. */
export interface NarrationPayload {
  readonly project: {
    readonly name: string;
    readonly type: string;
    readonly status: string;
    readonly phase: string | null;
    readonly goal: string | null;
  };
  readonly assessment: ProjectAssessment;
  readonly evidence: readonly {
    readonly id: string;
    readonly kind: string;
    readonly title: string;
    readonly observedAt: string;
    readonly url: string | null;
  }[];
}

export interface PortfolioNarrationPayload {
  readonly assessment: PortfolioAssessment;
  readonly projects: readonly {
    readonly id: string;
    readonly name: string;
    readonly status: string;
    readonly headline: string;
    readonly needsAttention: boolean;
    readonly freshness: string;
  }[];
}

export interface NarrationResult<T> {
  readonly narrative: T;
  readonly method: 'deterministic' | 'ai_narrated' | 'ai_failed_fallback';
  readonly error: string | null;
}

/**
 * Layer 2 of the Status Brain.
 *
 * A narrator may improve wording and ordering. It may not introduce work, dates, blockers or
 * completion that the deterministic assessment did not already establish — `validateNarrative`
 * enforces that, and a narrator that violates it is discarded in favour of the deterministic text.
 */
export interface BriefingNarrator {
  readonly name: string;
  isAvailable(): boolean;
  narrateProject(payload: NarrationPayload): Promise<NarrationResult<BriefingNarrative>>;
  narratePortfolio(
    payload: PortfolioNarrationPayload,
  ): Promise<NarrationResult<PortfolioNarrative>>;
}

export function buildNarrationPayload(
  project: Project,
  assessment: ProjectAssessment,
  evidence: readonly Evidence[],
): NarrationPayload {
  const keyIds = new Set(assessment.keyEvidenceIds);
  const selected = evidence
    .filter((item) => keyIds.has(item.id))
    .concat(evidence.filter((item) => !keyIds.has(item.id)).slice(0, 20))
    .slice(0, 40);

  return {
    project: {
      name: project.name,
      type: project.type,
      status: assessment.status,
      phase: assessment.phase,
      goal: project.goal,
    },
    assessment,
    evidence: selected.map((item) => ({
      id: item.id,
      kind: item.kind,
      title: item.title,
      observedAt: item.observedAt,
      url: item.url,
    })),
  };
}
