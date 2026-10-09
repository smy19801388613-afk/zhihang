import type { BrowserCaptureRecord, CaptureEditableFields, CaptureRequestReceipt } from './browser-capture.ts';
import type { JobSourceKind } from './job-source.ts';
import type { ResumeDesignPreset, ResumeDesignSkill, ResumeDesignSpec, ResumeQualityReport } from './resume-design.ts';
import type { ResumeScope } from './resume-scope.ts';
export interface AgentRun {
  version: 1; kind: 'experience' | 'job_analysis'; model: string;
  reviewed: boolean; passes: number; warnings: string[];
}
export interface Fact {
  id: string;
  text: string;
  source: string;
  sourceContext?: string;
  sourceQuotes?: string[];
  experience?: { id: string; title: string; parentId?: string; parentTitle?: string; kind: 'work' | 'internship' | 'project' | 'campus' | 'volunteer' | 'education' | 'skill' | 'other'; role?: string; date?: string };
  reviewNote?: string;
  confirmed: boolean;
}
export interface Profile {
  name: string; email: string; phone: string; school: string; education: string;
  major?: string;
  graduation: string; city: string; availability: string; targetRole: string;
  experienceText: string; facts: Fact[];
}
export interface Job { company: string; title: string; text: string; url: string; location?: string; industry?: string; roleFamily?: string; sourceKind?: JobSourceKind; sourceLabel?: string; candidateId?: string; jdComplete?: boolean }
export interface CareerDirection { id: string; industry: string; role: string; rationale: string; transferableSkills: string[]; gaps: string[]; entryRequirements: string; salaryContext: string }
export interface CareerAttachment { id: string; name: string; kind: 'document' | 'image'; size: number; text?: string }
export interface CareerChatContext { attachments?: Array<{ name: string; kind: 'document' | 'image'; text?: string; dataUrl?: string }>; forceReady?: boolean }
export type SwipeDecision = 'like' | 'dislike';
export interface CompanyCandidate {
  id: string; name: string; industry: string; role: string; rationale: string; requirements: string[];
  careerUrl: string; sourceLabel: string; checkedAt: string; hiringStatus: 'unverified' | 'listed'; selected: boolean;
  companyId?: string; logoUrl?: string; location?: string; salary?: string; jobDescription?: string;
  jobType?: string; publishedAt?: string; sourceJobId?: string; decision?: SwipeDecision;
  sourceKind?: JobSourceKind; jdComplete?: boolean; jdUserEdited?: boolean; education?: string; experience?: string; capturePlatform?: 'boss' | '58';
}
export interface JobSourceResult { id: string; label: string; status: 'ok' | 'error' | 'unsupported'; count: number; message?: string }
export interface JobDiscoveryResult { candidates: CompanyCandidate[]; sources: JobSourceResult[]; fetchedAt: string }
export interface ResearchSource { id: string; title: string; url: string; publishedAt?: string; fetchedAt: string; excerpt: string; readMethod: 'page' | 'search_snippet' }
export interface CompanyResearch {
  inputKey?: string;
  userSourceUrls?: string[];
  companyId: string; companyName: string; role: string; generatedAt: string; mode: 'demo' | 'live';
  status: 'ready' | 'partial' | 'unavailable'; summary: string;
  findings: Array<{ id: string; topic: 'business' | 'recent' | 'role'; text: string; sourceId: string; quote: string }>;
  questions: string[]; sources: ResearchSource[]; warnings: string[];
}
export interface CareerExploration {
  messages: InterviewMessage[]; directions: CareerDirection[]; selectedDirectionIds: string[];
  companies: CompanyCandidate[]; stage: 'conversation' | 'directions' | 'companies'; profileStale?: boolean;
  swipeHistory?: Array<{ companyId: string; previousDecision?: SwipeDecision; previousSelected: boolean }>;
  jobSearch?: { fetchedAt: string; sources: JobSourceResult[] };
  conversationPhase?: 'explore' | 'compare' | 'ready'; decisionSummary?: string;
}
export interface ResumeItem { id: string; title: string; subtitle: string; date: string; content: string; factIds: string[] }
export interface ResumeSection { id: string; title: string; items: ResumeItem[] }
export interface ResumeDocument { headline: string; summary: string; sections: ResumeSection[]; theme: 'modern' | 'classic'; accent: 'forest' | 'navy' | 'plum' | 'ink'; design?: ResumeDesignSpec }
export interface ResumeImport { filename: string; importedAt: string; text: string; proposedProfile: Omit<Profile, 'facts'>; warnings: string[] }
export interface MatchItem {
  requirement: string; evidence: string; factIds: string[]; status: 'supported' | 'partial' | 'missing';
  category?: 'required' | 'capability' | 'preferred' | 'responsibility';
  sourceQuotes?: string[];
  evidenceState?: 'supported' | 'partial' | 'unknown' | 'unmet';
  profileFields?: string[];
  transferability?: 'direct' | 'transferable' | 'none';
  gap?: string;
}
export interface JobAnalysis {
  summary: string; matches: MatchItem[]; questions: string[]; directionAdvice: string[];
  curation?: { mode: 'model' | 'rules'; warnings: string[]; sourceCount: number };
  metadata?: { industry?: string; location?: string; salary?: string; other?: string[] };
  agentRun?: AgentRun;
  roleOverview?: string;
  contextNotes?: Array<{ note: string; sourceQuotes: string[] }>;
  coreTasks?: Array<{ task: string; sourceQuotes: string[] }>;
  applicationAdvice?: { recommendation: 'consider' | 'clarify_first' | 'deprioritize'; reason: string; strengths: string[]; gaps: string[]; nextSteps: string[] };
}
export interface ResumeBullet { text: string; factIds: string[] }
export interface ResumeVersion {
  id: string; version: number; createdAt: string; profile: Profile; job: Job;
  bullets: ResumeBullet[]; rationale: string; approved: boolean;
  document?: ResumeDocument; parentId?: string; editMessages?: InterviewMessage[]; reviewNotes?: string[]; authoredBy?: 'user' | 'model'; stale?: boolean;
  generation?: { mode: 'demo' | 'live'; model: string };
  designSkill?: ResumeDesignSkill;
  quality?: ResumeQualityReport;
  scope?: ResumeScope;
  collectionId?: string;
}
export type ApplicationStatus = 'prepared' | 'filled' | 'submitting' | 'confirmed' | 'unknown' | 'failed';
export interface Application {
  id: string; resumeId: string; company: string; jobTitle: string;
  status: ApplicationStatus; createdAt: string; updatedAt: string;
  receipt?: string; evidence?: string; error?: string; simulated: true;
  targetJob?: Job;
}
export interface InterviewMessage { role: 'assistant' | 'user'; content: string; attachments?: CareerAttachment[]; sources?: ResearchSource[]; searchWarning?: string }
export interface Interview { resumeId: string; messages: InterviewMessage[] }
export interface RunEvent { id: string; at: string; title: string; detail: string }
export interface WorkspaceState {
  id: string; revision: number; profile: Profile; job: Job;
  questions: string[]; analysis: JobAnalysis | null;
  resumes: ResumeVersion[]; activeResumeId: string | null;
  resumeVersionCounter?: number;
  applications: Application[]; interview: Interview | null; events: RunEvent[];
  exploration?: CareerExploration; resumeImport?: ResumeImport | null;
  factPreview?: { facts: Fact[]; questions: string[]; sourceText: string; createdAt: string; agentRun?: AgentRun } | null;
  factOrganization?: AgentRun;
  companyJobs?: Record<string, Job>;
  companyResearch?: Record<string, CompanyResearch>;
  browserCaptures?: Record<string, BrowserCaptureRecord>;
  browserCaptureRequests?: CaptureRequestReceipt[];
  resumeDesign?: { skills: ResumeDesignSkill[]; currentSkillId: string | null; defaultSkillId: string | null; preview: ResumeDesignSkill | null };
}
export interface AppStatus {
  mode: 'demo' | 'live'; model: string; modelConfigured: boolean;
  browserAvailable: boolean; version: string;
  imageInput?: boolean;
}
export type Action =
  | { type: 'load_example' }
  | { type: 'clear_profile' }
  | { type: 'clear_job' }
  | { type: 'preview_resume_design'; name: string; instructions: string; preset: ResumeDesignPreset }
  | { type: 'save_resume_design'; setDefault: boolean }
  | { type: 'select_resume_design'; skillId: string | null; setDefault?: boolean }
  | { type: 'delete_resume_design'; skillId: string }
  | { type: 'apply_resume_design'; resumeId: string }
  | { type: 'extract_profile'; profile: Omit<Profile, 'facts'> }
  | { type: 'accept_resume_import'; profile: Omit<Profile, 'facts'> }
  | { type: 'discard_resume_import' }
  | { type: 'career_chat'; message: string; attachmentIds?: string[] }
  | { type: 'clear_career_chat' }
  | { type: 'finish_career_chat' }
  | { type: 'preview_fact_split' }
  | { type: 'apply_fact_split' }
  | { type: 'discard_fact_split' }
  | { type: 'select_directions'; directionIds: string[] }
  | { type: 'recommend_companies' }
  | { type: 'select_companies'; companyIds: string[] }
  | { type: 'swipe_company'; companyId: string; decision: SwipeDecision }
  | { type: 'undo_company_swipe' }
  | { type: 'refresh_jobs' }
  | { type: 'research_company'; companyId: string; refresh?: boolean; sourceUrls?: string[] }
  | { type: 'activate_company'; companyId: string }
  | { type: 'open_company'; companyId: string }
  | { type: 'update_fact'; factId: string; text: string; confirmed: boolean }
  | { type: 'save_job'; job: Job }
  | { type: 'save_browser_capture'; captureId: string; edits: Partial<CaptureEditableFields> }
  | { type: 'analyze_job' }
  | { type: 'generate_resume' }
  | { type: 'generate_general_resume'; name: string; focus: string }
  | { type: 'generate_multi_resume'; name: string; focus: string; candidateIds: string[]; includeCurrentJob?: boolean }
  | { type: 'save_resume_edit'; resumeId: string; document: ResumeDocument; profile: Omit<Profile, 'facts'> }
  | { type: 'chat_resume_edit'; resumeId: string; message: string }
  | { type: 'approve_resume'; resumeId: string }
  | { type: 'delete_resume'; resumeId: string }
  | { type: 'prepare_application'; resumeId: string }
  | { type: 'prepare_applications'; resumeId: string; candidateIds: string[]; includeCurrentJob?: boolean }
  | { type: 'fill_application'; applicationId: string }
  | { type: 'fill_applications'; applicationIds: string[] }
  | { type: 'submit_application'; applicationId: string; confirmed: boolean }
  | { type: 'submit_applications'; applicationIds: string[]; confirmed: boolean }
  | { type: 'verify_application'; applicationId: string }
  | { type: 'delete_application'; applicationId: string }
  | { type: 'start_interview'; resumeId: string }
  | { type: 'answer_interview'; answer: string };
export type ActionRequest = Action & { expectedRevision: number };
export interface ModelEngine {
  mode: 'demo' | 'live'; model: string;
  previewResumeDesign?(input: { name: string; instructions: string; preset: ResumeDesignPreset }): Promise<ResumeDesignSkill>;
  extractProfile(profile: Omit<Profile, 'facts'>): Promise<{ facts: Fact[]; questions: string[]; agentRun?: AgentRun }>;
  analyzeJob(profile: Profile, job: Job): Promise<JobAnalysis>;
  draftResume(profile: Profile, job: Job, analysis: JobAnalysis, designSkill?: ResumeDesignSkill, scope?: ResumeScope): Promise<{ bullets: ResumeBullet[]; rationale: string; document?: ResumeDocument; reviewNotes?: string[]; authoredBy?: 'model' }>;
  interview(resume: ResumeVersion, messages: InterviewMessage[]): Promise<string>;
}
