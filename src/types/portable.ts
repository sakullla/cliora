export interface PortableItem {
  key: string;
  kind: string;
  toolId?: string | null;
  label: string;
  status: 'available' | 'new' | 'same' | 'conflict';
  pendingFields: string[];
  localPreview?: string | null;
  incomingPreview?: string;
}

export interface PortableApplyTarget { profileId: string; projectId: string | null }
export interface PortableProjectLink { projectId: string; path: string }
export interface PortableImportReport { imported: number; targets: { label: string; status: 'linked' | 'applied' | 'failed'; detail: string | null }[] }

export interface PortablePreview {
  previewId: string;
  items: PortableItem[];
  pendingProjects: number;
}

export interface WebdavSetup {
  endpoint: string;
  username: string;
  authPassword: string;
  encryptionPassword: string;
  previousEncryptionPassword: string;
  enabled: boolean;
}

export interface SyncConflict {
  key: string;
  label: string;
  localPresent: boolean;
  localDigest: string;
  remoteVersions: number;
  remoteDeleted: boolean;
  versions: { id: string; digest: string; deleted: boolean }[];
}

export interface SyncStatus {
  configured: boolean;
  enabled: boolean;
  endpoint: string | null;
  lastSuccess: number | null;
  lastError: string | null;
  retryAfter: number | null;
  uploaded: number;
  downloaded: number;
  pendingChanges: number;
  conflicts: SyncConflict[];
}

export interface ConflictPreview {
  key: string;
  localSummary: string;
  versions: { id: string; summary: string; deleted: boolean }[];
}
