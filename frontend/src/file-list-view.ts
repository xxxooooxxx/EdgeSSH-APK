import type { SFTPEntry } from './file-manager';

export interface FileListItem {
  id: string;
  name: string;
  index: number;
  entry: SFTPEntry;
  columns: string[];
}

/** 只交换展示数据和选中项；远端操作仍由 FileManager 统一处理。 */
export interface FileListSnapshot {
  items: FileListItem[];
  selectedId?: string;
  chinese: boolean;
}

export interface FileListView {
  render(snapshot: FileListSnapshot): void;
}
