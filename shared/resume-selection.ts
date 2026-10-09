import type { Job, ResumeVersion, WorkspaceState } from './types.ts';

const normalizedName = (value: string) => value.trim().toLowerCase().replace(/\s+/g, '');
const contentKey = (job: Job) => JSON.stringify([
  normalizedName(job.company), normalizedName(job.title), job.candidateId || '',
  job.text.trim(), job.url.trim(), job.industry || '', job.roleFamily || '',
  job.sourceKind || 'user_jd', job.jdComplete ?? null, job.location || '',
]);

/** An explicit version selection may open history; automatic selection stays on the current job. */
export function selectWorkspaceResume(
  state: Pick<WorkspaceState, 'job' | 'resumes' | 'activeResumeId'>,
  selectedId: string,
): ResumeVersion | undefined {
  const explicit = state.resumes.find(resume => resume.id === selectedId);
  if (explicit) return explicit;

  const active = state.resumes.find(resume => resume.id === state.activeResumeId);
  if (active?.scope && !active.stale) return active;
  const hasTarget = !!(state.job.candidateId || state.job.company.trim() || state.job.title.trim() || state.job.text.trim());
  // Clearing the target must remain empty across reloads. History only opens
  // through an explicit version selection, even if an old active id survives.
  if (!hasTarget) return undefined;

  const currentKey = contentKey(state.job);
  const matches = (resume: ResumeVersion) => !resume.scope && !resume.stale && contentKey(resume.job) === currentKey;
  return active && matches(active) ? active : state.resumes.findLast(matches);
}
