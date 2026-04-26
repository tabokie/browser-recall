export const RankingAlgorithm: Readonly<{
  Content: 0;
  0: 'Content';
}>;

export class HistoryEntry {
  constructor(url: string, title: string);
  content: string;
  timestamp: bigint;
  title: string;
  url: string;
  free(): void;
  setContent(content: string): void;
  [Symbol.dispose](): void;
}

export class SearchEngine {
  constructor();
  addEntry(entry: HistoryEntry): void;
  free(): void;
  search(
    query: string,
    algorithm?: number,
  ): Promise<
    Array<{
      url: string;
      title: string;
      timestamp: number;
      score: number;
    }>
  >;
  [Symbol.dispose](): void;
}

export function searchBatch(
  history_dir: any,
  pages_dir: any,
  query: string,
  file_names: string[],
): Promise<
  Array<{
    url: string;
    title: string;
    timestamp: number;
    score: number;
  }>
>;

export function searchNotes(
  notes_dir: any,
  query: string,
): Promise<Array<{ url: string; noteSlug: string }>>;

export function searchSnapshots(
  snapshots_dir: any,
  query: string,
  file_names: string[],
): Promise<Array<{ slug: string }>>;
