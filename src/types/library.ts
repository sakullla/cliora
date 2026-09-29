export type LibraryKind = 'prompt' | 'rule';

export type LibraryItem = {
  id: string;
  kind: LibraryKind;
  title: string;
  body: string;
  category: string;
  projectId: string | null;
  version: number;
  updatedAt: number;
};

export type LibraryDraft = Pick<LibraryItem, 'kind' | 'title' | 'body' | 'category' | 'projectId'> & {
  id: string | null;
  expectedVersion: number | null;
};
