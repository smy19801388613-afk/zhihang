import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Profile, WorkspaceState } from '../shared/types.ts';
import { sameResumeCollection, sameTargetJob } from './resume-edit.ts';

export const emptyProfile = (): Profile => ({ name: '', email: '', phone: '', school: '', education: '', major: '', graduation: '', city: '', availability: '', targetRole: '', experienceText: '', facts: [] });
const resumeCounter = (state: WorkspaceState) => Math.max(0, ...[state.resumeVersionCounter, ...state.resumes.map(resume => resume.version)].filter((value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0));
export function emptyState(): WorkspaceState {
  return { id: randomUUID(), revision: 0, profile: emptyProfile(), job: { company: '', title: '', text: '', url: '' }, questions: [], analysis: null, resumes: [], resumeVersionCounter: 0, activeResumeId: null, applications: [], interview: null, events: [] };
}
export class ConflictError extends Error {
  status = 409;
  constructor() { super('页面版本已过期，请刷新后检查最新内容，再重新操作。'); }
}
export class Store {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sandbox_tokens (application_id TEXT PRIMARY KEY, token TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sandbox_receipts (application_id TEXT PRIMARY KEY, receipt TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
    `);
    this.db.prepare('INSERT OR IGNORE INTO workspace (id, revision, data) VALUES (1, 0, ?)').run(JSON.stringify(emptyState()));
    const state = this.read();
    let changed = false;
    for (const app of state.applications) {
      if (app.status === 'submitting') { app.status = 'unknown'; app.error = '上次提交过程中服务中断，请核验结果，勿重复提交。'; changed = true; }
      if (app.status === 'filled') { app.status = 'prepared'; app.error = '服务重启后需要重新填写并核对表单。'; changed = true; }
    }
    if (changed) this.save(state, state.revision);
  }
  read(): WorkspaceState {
    const row = this.db.prepare('SELECT data FROM workspace WHERE id=1').get() as { data: string };
    const state = JSON.parse(row.data) as WorkspaceState;
    // Read-time migration only: opening an old workspace does not create a revision.
    state.resumeVersionCounter = resumeCounter(state);
    state.profile.major ??= '';
    // Migrate v0.1 snapshots without overwriting their document content or receipts.
    const fields = ['name', 'email', 'phone', 'school', 'education', 'major', 'graduation', 'city', 'availability', 'targetRole', 'experienceText'] as const;
    for (const resume of state.resumes) if (resume.stale === undefined) {
      const profileMatches = fields.every(key => (resume.profile[key] || '') === (state.profile[key] || ''))
        && JSON.stringify(resume.profile.facts.map(f => [f.id, f.text, f.confirmed])) === JSON.stringify(state.profile.facts.map(f => [f.id, f.text, f.confirmed]));
      const newer = state.resumes.some(other => other.version > resume.version && sameResumeCollection(other, resume));
      const targets = resume.scope ? resume.scope.targetJobs : [resume.job];
      const jobChanged = targets.some(job => sameTargetJob(state.job, job) && state.job.text !== job.text);
      resume.stale = !profileMatches || newer || jobChanged;
    }
    state.resumeImport ??= null;
    state.resumeDesign ??= { skills: [], currentSkillId: null, defaultSkillId: null, preview: null };
    state.companyJobs ??= {};
    state.companyResearch ??= {};
    state.browserCaptures ??= {};
    state.browserCaptureRequests ??= [];
    state.exploration ??= { messages: [], directions: [], selectedDirectionIds: [], companies: [], stage: 'conversation' };
    return state;
  }
  save(state: WorkspaceState, expected: number): WorkspaceState {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT revision, data FROM workspace WHERE id=1').get() as { revision: number; data: string };
      if (row.revision !== expected) throw new ConflictError();
      const previous = JSON.parse(row.data) as WorkspaceState;
      const next = { ...state, revision: expected + 1, resumeVersionCounter: Math.max(resumeCounter(previous), resumeCounter(state)) };
      const result = this.db.prepare('UPDATE workspace SET revision=?, data=? WHERE id=1 AND revision=?').run(next.revision, JSON.stringify(next), expected);
      if (result.changes !== 1) throw new ConflictError();
      // Authorization and receipts disappear in the same transaction as their
      // application. A failed CAS or cleanup rolls back all three records.
      const retained = new Set(next.applications.map(application => application.id));
      for (const application of previous.applications) if (!retained.has(application.id)) {
        this.db.prepare('DELETE FROM sandbox_tokens WHERE application_id=?').run(application.id);
        this.db.prepare('DELETE FROM sandbox_receipts WHERE application_id=?').run(application.id);
      }
      this.db.exec('COMMIT');
      return next;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  token(applicationId: string): string {
    let row = this.db.prepare('SELECT token FROM sandbox_tokens WHERE application_id=?').get(applicationId) as { token: string } | undefined;
    if (!row) {
      const token = randomBytes(32).toString('hex');
      this.db.prepare('INSERT INTO sandbox_tokens VALUES (?, ?, ?)').run(applicationId, token, new Date().toISOString());
      row = { token };
    }
    return row.token;
  }
  validToken(applicationId: string, token: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM sandbox_tokens WHERE application_id=? AND token=?').get(applicationId, token));
  }
  receipt(applicationId: string): string | undefined {
    const row = this.db.prepare('SELECT receipt FROM sandbox_receipts WHERE application_id=?').get(applicationId) as { receipt: string } | undefined;
    return row?.receipt;
  }
  createReceipt(applicationId: string): string {
    const receipt = `DEMO-${randomUUID().slice(0, 8).toUpperCase()}`;
    this.db.prepare('INSERT OR IGNORE INTO sandbox_receipts VALUES (?, ?, ?)').run(applicationId, receipt, new Date().toISOString());
    return this.receipt(applicationId)!;
  }
  close() { this.db.close(); }
}
