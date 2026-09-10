import { newId } from '../core/ids.js';

const STOPWORDS = new Set(['a', 'an', 'the', 'and', 'with', 'that', 'this', 'for', 'to', 'of', 'in', 'on', 'me', 'my', 'i', 'please', 'build', 'make', 'create', 'add']);

/**
 * Deterministic planner. Turns a goal (and later, change suggestions) into a
 * concrete task list without needing any model access, so the whole autonomous
 * loop is testable end to end and never stalls waiting on an external service.
 */
export class DeterministicPlanner {
  constructor({ maxFeatures = 6 } = {}) {
    this.maxFeatures = maxFeatures;
  }

  /**
   * @param {object} project
   * @param {{change?: string}} [opts]
   * @returns {Promise<{summary:string, acceptance:string[], tasks:object[], rationale:string, scope:string[]}>}
   */
  async plan(project, { change } = {}) {
    const source = change ?? project.goal ?? project.title ?? 'the requested work';
    const features = extractFeatures(source, this.maxFeatures);
    const scope = features.map((f) => f.label);

    if (project.evaluationOnly && !change) {
      return {
        summary: `Evaluation of ${short(project.title)}`,
        acceptance: [`A written evaluation of ${short(project.title)} with a recommendation`],
        scope,
        rationale: 'Evaluation-only request: assess and report, build nothing.',
        tasks: [{ key: 'evaluate', title: `Evaluate ${short(project.title)}`, kind: 'deliver', dependsOn: [] }],
      };
    }

    const implementKeys = [];
    const tasks = [];
    for (const feature of features) {
      const key = `impl:${feature.slug}`;
      implementKeys.push(key);
      tasks.push({
        key,
        title: `${change ? 'Update' : 'Build'} ${feature.label}`,
        kind: 'implement',
        dependsOn: [],
        meta: { feature: feature.label },
      });
    }

    const verifyKey = `verify:${change ? 'change' : 'build'}`;
    tasks.push({ key: verifyKey, title: `Verify ${short(project.title)}`, kind: 'verify', dependsOn: [...implementKeys] });
    const reviewKey = `review:${change ? 'change' : 'build'}`;
    tasks.push({ key: reviewKey, title: `Review ${short(project.title)}`, kind: 'review', dependsOn: [verifyKey] });
    tasks.push({ key: `deliver:${change ? 'change' : 'build'}`, title: `Deliver ${short(project.title)}`, kind: 'deliver', dependsOn: [reviewKey] });

    return {
      summary: change ? `Revision: ${short(change, 90)}` : `Build ${short(project.title)}`,
      acceptance: [
        ...features.map((f) => `${f.label} works as described`),
        'Automated checks pass',
        'The result is delivered with a short summary',
      ],
      scope,
      rationale: change
        ? 'Folded the change into the existing plan; earlier scope is retained.'
        : 'Decomposed the goal into buildable pieces, then verify, review and deliver.',
      tasks,
    };
  }
}

/** Split a free-text goal into distinct, buildable features. */
export function extractFeatures(text, max = 6) {
  const raw = String(text ?? '').trim();
  if (!raw) return [{ label: 'the requested work', slug: 'work' }];

  let parts = raw
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean);

  if (parts.length < 2) {
    parts = raw
      .split(/,| and (?=\w)| plus (?=\w)|;/i)
      .map((p) => p.trim())
      .filter(Boolean);
  }

  const seen = new Set();
  const features = [];
  for (const part of parts) {
    const label = cleanLabel(part);
    if (!label) continue;
    const slug = slugify(label);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    features.push({ label, slug });
    if (features.length >= max) break;
  }
  if (features.length === 0) {
    const label = cleanLabel(raw) || 'the requested work';
    features.push({ label, slug: slugify(label) || 'work' });
  }
  return features;
}

const LABEL_PREFIXES = [
  /^(?:please|can you|could you|go ahead and|also|and|plus|then|next|now|as well as)\s+/i,
  /^(?:build|make|create|add|implement|set ?up|write|support|include|give me|i want|i need)\s+/i,
  /^(?:me\s+)?(?:a|an|the|some)\s+/i,
];

function cleanLabel(part) {
  let label = String(part).replace(/\s+/g, ' ').trim();
  // Strip stacked lead-ins ("also add a dark mode") until nothing is left to strip.
  for (let pass = 0; pass < 6; pass++) {
    const before = label;
    for (const re of LABEL_PREFIXES) label = label.replace(re, '');
    if (label === before) break;
  }
  return label.trim().slice(0, 80);
}

function slugify(label) {
  return String(label)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .slice(0, 4)
    .join('-') || String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24);
}

function short(text, max = 60) {
  const t = String(text ?? '').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export { short as shortenTitle, newId as _newId };
