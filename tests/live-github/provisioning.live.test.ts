import { describe, expect, it } from 'vitest';

import { GithubRepositoryProvisioner } from '@/server/providers/github/provisioner';
import { repositorySlug } from '@/domain/repository-name';

/**
 * Real GitHub, on purpose, and kept away from everything else.
 *
 * ## Why this is its own project and its own switch
 *
 * Every other test of provisioning uses `RecordingProvisioner`, which adopts a repository it has
 * already made. That proves the *sequence* is idempotent — that saying "go ahead" twice asks for
 * one repository rather than two — through the real provisioning service with only the HTTP
 * replaced. What it cannot prove is that GitHub agrees, because a stand-in written from the same
 * reading of the API will pass against that reading for ever.
 *
 * So this exists, and it is deliberately harder to run than the rest: reaching somebody's GitHub
 * account is a different decision from spending Claude capacity, and it gets a different switch.
 *
 *     JARVIS_LIVE_GITHUB=true \
 *     GITHUB_PROVISION_TOKEN=… \
 *     JARVIS_LIVE_GITHUB_REPO=BKimble1/quickpick \
 *     npm run test:live:github
 *
 * ## What it does to the account
 *
 * Nothing. It reads, and it calls `ensure` for a repository that already exists — which is the
 * adoption path, and must report `created: false`. It never creates one: a test that made a
 * repository on somebody's account every time it ran would be a worse bug than the one it checks
 * for, and there is no method here that deletes one afterwards.
 */

const TARGET = process.env.JARVIS_LIVE_GITHUB_REPO ?? '';
const [OWNER = '', REPO = ''] = TARGET.split('/');

describe('the real repository provisioner', () => {
  it('is configured, and says which account it would write to', () => {
    const provisioner = new GithubRepositoryProvisioner();

    expect(
      provisioner.isConfigured(),
      'Set GITHUB_PROVISION_TOKEN. This suite is opt-in precisely because it uses it.',
    ).toBe(true);
    expect(provisioner.describeTarget()?.length ?? 0).toBeGreaterThan(0);
  });

  it('finds a repository that exists', async () => {
    expect(
      TARGET,
      'Set JARVIS_LIVE_GITHUB_REPO=owner/name to a repository you already have. Nothing is created.',
    ).toMatch(/^[^/]+\/[^/]+$/);

    const found = await new GithubRepositoryProvisioner().find(OWNER, REPO);

    expect(found, `${TARGET} was not found by the provisioning credential.`).not.toBeNull();
    expect(found?.fullName.toLowerCase()).toBe(TARGET.toLowerCase());
    expect(found?.defaultBranch.length).toBeGreaterThan(0);
  });

  it('adopts an existing repository rather than making a second one', async () => {
    expect(TARGET).toMatch(/^[^/]+\/[^/]+$/);

    /*
     * The assertion the mocked suite cannot make. `ensure` is the call the conversation makes on
     * "go ahead", and on a name that is already taken by the owner's own repository it must come
     * back as an adoption. `created: true` here would mean a second repository, on a real account,
     * every time somebody said go ahead twice.
     */
    const handle = await new GithubRepositoryProvisioner().ensure({
      name: REPO,
      description: null,
    });

    expect(handle.created, 'ensure() created a repository that already existed').toBe(false);
    expect(handle.fullName.toLowerCase()).toBe(TARGET.toLowerCase());
  });

  it('asks for the name the slug rule produces, so the two never drift', () => {
    /*
     * The conversation slugs the product name and hands that to `ensure`. If the slug rule and the
     * repository the owner actually has disagree, "go ahead" makes a second repository — which is
     * the whole failure mode, arriving through the back door.
     */
    expect(repositorySlug(REPO)).toBe(REPO.toLowerCase());
  });
});
