import React, { useLayoutEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Tree, type NodeRendererProps, type RowRendererProps, type TreeApi } from 'react-arborist';
import { fileKind, fileKindLabels, fileKindPaths } from './file-kind';
import type { FileListItem, FileListSnapshot, FileListView } from './file-list-view';
import './file-list.css';

interface FileListActions {
  select(index: number): void;
  activate(index: number): void;
}

function FileRow({ node, attrs, innerRef, children }: RowRendererProps<FileListItem>) {
  return <div {...attrs} ref={innerRef} className={`files-list-row${node.isSelected ? ' is-selected' : ''}`}
    aria-label={node.data.name} onFocus={(event) => event.stopPropagation()}
    onClick={() => node.select()} onDoubleClick={() => node.activate()}>
    {children}
  </div>;
}

function FileNode({ node, style }: NodeRendererProps<FileListItem>) {
  const { entry, columns } = node.data;
  const kind = fileKind(entry);
  return <div className="files-list-columns" style={style}>
    <span className="files-list-name" title={entry.name}>
      <svg className={`files-list-icon is-${kind}`} data-file-kind={kind} viewBox="0 0 24 24" aria-hidden="true">
        {fileKindPaths[kind].map((path) => <path key={path} d={path} />)}
      </svg>
      <span>{entry.name}</span>
    </span>
    {columns.map((text, index) => <span key={index} className={`files-list-meta column-${index}`} title={text}>{text}</span>)}
  </div>;
}

function FileList({ snapshot, actions }: { snapshot: FileListSnapshot; actions: FileListActions }) {
  const viewport = useRef<HTMLDivElement>(null);
  const tree = useRef<TreeApi<FileListItem>>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [mobile, setMobile] = useState(() => matchMedia('(max-width: 600px)').matches);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(viewport.current!);
    const media = matchMedia('(max-width: 600px)');
    const update = () => setMobile(media.matches);
    media.addEventListener('change', update);
    return () => { observer.disconnect(); media.removeEventListener('change', update); };
  }, []);
  const headers = snapshot.chinese
    ? ['名称', '大小', '类型', '修改时间', '权限', '用户', '组']
    : ['Name', 'Size', 'Type', 'Modified', 'Permissions', 'Owner', 'Group'];
  return <>
    <div className="files-list-header files-list-columns" aria-hidden="true">
      {headers.map((title, index) => <span key={title} className={index ? `column-${index - 1}` : ''}>{title}</span>)}
    </div>
    <div className="files-list-viewport" ref={viewport} onKeyDownCapture={(event) => {
      // Arborist 的 Enter 默认用于内联改名；这里保持文件管理器“Enter 打开”的既有约定。
      if (event.key !== 'Enter') return;
      event.preventDefault();
      event.stopPropagation();
      tree.current?.focusedNode?.activate();
    }}>
      {/* 右侧仍是当前目录的平铺列表；目录展开由左侧负责，不额外维护第二棵远端树。 */}
      {size.width > 0 && size.height > 0 && <Tree<FileListItem>
        ref={tree} data={snapshot.items} width={size.width} height={size.height}
        rowHeight={mobile ? 48 : 44} indent={0} overscanCount={4}
        selection={snapshot.selectedId} selectionFollowsFocus disableMultiSelection
        disableDrag disableDrop disableEdit disableDeselectOnClick
        aria-label={snapshot.chinese ? '文件列表' : 'File list'}
        renderRow={FileRow}
        onSelect={(nodes) => actions.select(nodes[0]?.data.index ?? -1)}
        onActivate={(node) => actions.activate(node.data.index)}>
        {FileNode}
      </Tree>}
    </div>
  </>;
}

/** React 只挂在独立文件页内；卸载后把同一会话交还给原生终端表格。 */
export class ArboristFileList implements FileListView {
  private readonly root: Root;
  private revision = 0;

  constructor(private readonly host: HTMLElement, private readonly actions: FileListActions) {
    this.root = createRoot(host);
  }

  render(snapshot: FileListSnapshot): void {
    const items = snapshot.items.map((item) => {
      const label = fileKindLabels[fileKind(item.entry)];
      return { ...item, columns: item.columns.map((text, index) => index === 1 && item.entry.type === 'file'
        ? label[snapshot.chinese ? 'zh' : 'en'] : text) };
    });
    // 新目录 / 刷新后清空旧的键盘焦点和滚动位置，避免同名文件继承上一个目录的选中状态。
    this.root.render(<FileList key={++this.revision} snapshot={{ ...snapshot, items }} actions={this.actions} />);
  }

  destroy(): void {
    this.root.unmount();
    this.host.remove();
  }
}
