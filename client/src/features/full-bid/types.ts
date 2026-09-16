import type { ExportFormatConfig } from '../../shared/types/exportFormat';
import type { WordExportResult } from '../../shared/types/ipc';

export type FullBidVolumeStatus = 'ready' | 'missing' | 'running';

export interface FullBidStatus {
  canExport: boolean;
  blockingMessage: string;
  projectName: string;
  technicalProjectName: string;
  businessProjectName: string;
  companyName: string;
  technical: { status: FullBidVolumeStatus; label: string; sectionCount: number };
  business: { status: FullBidVolumeStatus; label: string; sectionCount: number };
  mergeOrder: string[];
}

export interface FullBidBridge {
  load: () => Promise<FullBidStatus>;
  export: (payload: { requestId: string; export_format: ExportFormatConfig }) => Promise<WordExportResult>;
}
