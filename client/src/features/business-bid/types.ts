import type { TextModelSelection } from '../../shared/types/config';
import type { TaskEventTask, WordExportResult } from '../../shared/types/ipc';
export interface BusinessRequirement {
  id: string; title: string; quote: string; section: string; kind: string;
  sourceId: string; sourceName: string; segment: number;
}
export type BusinessAnalysis = Record<'directory' | 'qualifications' | 'disqualifications' | 'fields' | 'terms', BusinessRequirement[]>;
export interface BusinessEvidence {
  id: string; kind: string; name: string; certificateName: string; tags: string;
  eligible: boolean; reason: string; confirmed: boolean; requirementIds: string[];
  suggestedRequirementIds: string[]; validUntil: string;
  files: { name: string; sourcePath: string; sha256: string }[];
}
export interface BusinessBidState {
  companyName: string; projectName: string; deadline: string;
  files: { id: string; name: string; chars: number; parserLabel: string }[];
  evidence: BusinessEvidence[]; excludedEvidence: number;
  analysis: BusinessAnalysis | null; analysisComplete: boolean; analysisConfirmed: boolean;
  analysisCoverage: { completed: number; total: number } | null;
  analysisTask: TaskEventTask | null;
  fieldValues: Record<string, string>; textModelSelection: TextModelSelection | null;
  draft: { sections: { id: string; title: string; content: string }[]; pending: { label: string; reason: string; source: string }[]; pendingMarkdown: string; generatedAt: string } | null;
}
export interface BusinessBidReview {
  projectName?: string; deadline?: string; fieldValues?: Record<string, string>;
  textModelSelection?: TextModelSelection; analysisConfirmed?: boolean;
  evidence?: { id: string; confirmed: boolean; requirementIds: string[] }[];
}
export interface BusinessBidBridge {
  load: () => Promise<BusinessBidState>;
  importDocuments: (paths?: string[]) => Promise<{ state: BusinessBidState; success: boolean; message: string }>;
  readSource: (id: string) => Promise<string>;
  importEvidence: () => Promise<BusinessBidState>;
  saveReview: (payload: BusinessBidReview) => Promise<BusinessBidState>;
  analyze: () => Promise<TaskEventTask>;
  generate: () => Promise<BusinessBidState>;
  clear: () => Promise<BusinessBidState>;
  export: (payload: { kind: 'full' | 'pending'; requestId: string }) => Promise<WordExportResult>;
}
