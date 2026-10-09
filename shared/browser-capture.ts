export type CapturePlatform = 'boss' | '58';
export interface CaptureFields {
  company: string; title: string; city: string; salary: string; education: string; experience: string;
  jd: string; jdComplete: boolean; industry?: string; logoUrl?: string;
}
export type CaptureEditableFields = Omit<CaptureFields, 'logoUrl'>;
export interface CaptureJob {
  platform: CapturePlatform; sourceUrl: string; capturedAt: string; pageKind: 'detail' | 'list' | 'manual';
  fields: CaptureFields; edits?: Partial<CaptureEditableFields>;
}
export interface CaptureBatch { protocolVersion: 1; requestId: string; jobs: CaptureJob[] }
export interface CaptureImportResult { requestId: string; imported: number; updated: number; duplicates: number; errors: Array<{index: number; message: string}> }
export interface BrowserCaptureRecord {
  id: string; platform: CapturePlatform; sourceUrl: string; sourceJobId: string;
  firstCapturedAt: string; lastCapturedAt: string; receivedAt: string; updatedAt: string;
  jdCapturedAt?: string; jdEditedAt?: string;
  rawHistory: Array<Omit<CaptureJob, 'edits'>>; fields: CaptureFields;
  editedFields: Array<keyof CaptureEditableFields>; selected: boolean; decision?: 'like' | 'dislike';
}
export interface CaptureRequestReceipt { requestId: string; payloadHash: string; completedAt: string; result: CaptureImportResult }
