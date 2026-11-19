import type { WorkbenchWorktree } from './launch';

export type WorkspaceManifestLocation = { hostId: string; path: string };
export type WorkspaceManifestRepository = { id: string; name: string; locations: WorkspaceManifestLocation[] };
export type WorkspaceManifest = { schemaVersion: number; workspaceId: string; name: string; revision: number; repositories: WorkspaceManifestRepository[] };
export type WorkspaceLocation = { id: string; hostId: string; path: string | null; projectId: string | null; targetId: string | null; available: boolean; kind: 'repository' | 'legacy'; reason: string | null; worktrees: WorkbenchWorktree[] };
export type WorkspaceRepository = { id: string; name: string; favorite: boolean; locations: WorkspaceLocation[] };
export type BusinessWorkspace = { id: string; name: string; revision: number; manifestPath: string | null; manifestRevision: number | null; error: string | null; repositories: WorkspaceRepository[] };
export type WorkspaceCandidate = { path: string; name: string; kind: 'repository' | 'directory' | 'duplicate' | 'unavailable'; reason: string | null; commonDirectory: string | null };
export type WorkspaceScan = { candidates: WorkspaceCandidate[]; cancelled: boolean; partial: boolean };
export type WorkspaceMemberResult = { path: string; repositoryId: string | null; error: string | null };
export type WorkspaceManifestPreview = { manifest: WorkspaceManifest; path: string; digest: string; conflict: boolean; sourceRepositoryId: string | null; attached: boolean };
export type WorkspaceSessionContext = { sessionId: string; workspaceId: string; repositoryId: string; hostId: string; directory: string };
export type WorkspaceSelection = { workspaceId: string; repositoryId: string; directory: string; projectId: string | null; label: string };
