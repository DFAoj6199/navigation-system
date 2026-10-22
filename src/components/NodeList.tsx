import { useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { NODE_TYPE_COLORS, NODE_TYPE_LABELS } from '../lib/constants';
import { validateNodeName } from '../lib/nodes';
import type { MapNode, NodeType } from '../types';
import styles from './NodeList.module.css';

/** 节点列表：显示、选择、修改名称与坐标、修改类型、删除 */
export function NodeList() {
  const nodes = useAppStore((s) => s.nodes);
  const selectedNodeId = useAppStore((s) => s.selectedNodeId);
  const selectNode = useAppStore((s) => s.selectNode);
  const image = useAppStore((s) => s.image);

  return (
    <section className={styles.panel} aria-labelledby="node-list-heading">
      <div className={styles.headingRow}>
        <h2 id="node-list-heading" className={styles.heading}>节点列表</h2>
        <span className={styles.count} data-testid="node-count">共 {nodes.length} 个</span>
      </div>

      {!image && <p className={styles.empty}>上传底图后，这里会显示你添加的所有节点。</p>}
      {image && nodes.length === 0 && (
        <p className={styles.empty} data-testid="node-list-empty">
          还没有节点。可用地图上的“添加节点”模式点击添加，或在上方手动输入坐标添加。
        </p>
      )}

      {nodes.length > 0 && (
        <ul className={styles.list} data-testid="node-list">
          {nodes.map((node, index) => (
            <NodeItem
              key={node.id}
              node={node}
              index={index}
              selected={node.id === selectedNodeId}
              onSelect={() => selectNode(node.id)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

interface NodeItemProps {
  node: MapNode;
  index: number;
  selected: boolean;
  onSelect: () => void;
}

function NodeItem({ node, index, selected, onSelect }: NodeItemProps) {
  const renameNode = useAppStore((s) => s.renameNode);
  const moveNode = useAppStore((s) => s.moveNode);
  const deleteNode = useAppStore((s) => s.deleteNode);
  const setNodeType = useAppStore((s) => s.setNodeType);
  const pushNotice = useAppStore((s) => s.pushNotice);
  // 关联道路：用于删除前明确提示，避免留下悬空引用
  // 注意：这里返回原始 roads 数组（引用稳定），再计算关联，
  // 不要在选择器里 filter（每次返回新数组会触发无限重渲染）。
  const roads = useAppStore((s) => s.roads);

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(node.name);
  const [error, setError] = useState<string | null>(null);

  const [editingCoords, setEditingCoords] = useState(false);
  const [xDraft, setXDraft] = useState(String(node.point.x));
  const [yDraft, setYDraft] = useState(String(node.point.y));

  const commitName = () => {
    const nameError = validateNodeName(nameDraft);
    if (nameError) {
      setError(nameError);
      return;
    }
    const result = renameNode(node.id, nameDraft);
    if (!result.ok) {
      setError(result.error ?? '改名失败');
      return;
    }
    setError(null);
    setEditingName(false);
    pushNotice('success', `节点已改名为“${nameDraft.trim()}”`);
  };

  const commitCoords = () => {
    const x = xDraft.trim() === '' ? NaN : Number(xDraft);
    const y = yDraft.trim() === '' ? NaN : Number(yDraft);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      setError('坐标必须是有效数字');
      return;
    }
    const result = moveNode(node.id, x, y);
    if (!result.ok) {
      setError(result.error ?? '坐标修改失败');
      return;
    }
    setError(null);
    setEditingCoords(false);
    pushNotice('success', `节点坐标已更新为 (${Math.round(x)}, ${Math.round(y)})`);
  };

  return (
    <li
      className={[styles.item, selected ? styles.itemSelected : ''].join(' ')}
      data-testid="node-item"
      data-node-id={node.id}
      data-node-list-item="true"
      onClick={onSelect}
    >
      <div className={styles.itemHeader}>
        <span
          className={styles.dot}
          style={{ background: NODE_TYPE_COLORS[node.type] }}
          aria-hidden="true"
        />
        <span className={styles.order}>#{index + 1}</span>

        {editingName ? (
          <div className={styles.inlineEdit}>
            <input
              type="text"
              autoFocus
              value={nameDraft}
              maxLength={40}
              data-testid="rename-input"
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => {
                setNameDraft(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitName();
                if (e.key === 'Escape') {
                  setEditingName(false);
                  setNameDraft(node.name);
                  setError(null);
                }
              }}
            />
            <button type="button" onClick={(e) => { e.stopPropagation(); commitName(); }}>保存</button>
            <button
              type="button"
              className={styles.cancel}
              onClick={(e) => {
                e.stopPropagation();
                setEditingName(false);
                setNameDraft(node.name);
                setError(null);
              }}
            >
              取消
            </button>
          </div>
        ) : (
          <span className={styles.name} title={node.name}>{node.name}</span>
        )}
      </div>

      <div className={styles.metaRow}>
        <span className={styles.coords} data-testid="node-coords" data-x={node.point.x} data-y={node.point.y}>
          像素坐标 X={node.point.x}, Y={node.point.y}
        </span>

        {editingCoords ? (
          <div className={styles.coordEdit} onClick={(e) => e.stopPropagation()}>
            <input
              type="text"
              inputMode="decimal"
              value={xDraft}
              data-testid="edit-x"
              onChange={(e) => {
                setXDraft(e.target.value);
                setError(null);
              }}
            />
            <input
              type="text"
              inputMode="decimal"
              value={yDraft}
              data-testid="edit-y"
              onChange={(e) => {
                setYDraft(e.target.value);
                setError(null);
              }}
            />
            <button type="button" onClick={commitCoords}>应用</button>
            <button
              type="button"
              className={styles.cancel}
              onClick={() => {
                setEditingCoords(false);
                setXDraft(String(node.point.x));
                setYDraft(String(node.point.y));
                setError(null);
              }}
            >
              取消
            </button>
          </div>
        ) : (
          <div className={styles.actions}>
            <select
              className={styles.typeSelect}
              value={node.type}
              aria-label="节点类型"
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => {
                setNodeType(node.id, e.target.value as NodeType);
              }}
            >
              {(Object.keys(NODE_TYPE_LABELS) as NodeType[]).map((type) => (
                <option key={type} value={type}>{NODE_TYPE_LABELS[type]}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setEditingName(true);
                setNameDraft(node.name);
              }}
            >
              改名
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setEditingCoords(true);
                setXDraft(String(node.point.x));
                setYDraft(String(node.point.y));
              }}
            >
              改坐标
            </button>
            <button
              type="button"
              className={styles.deleteButton}
              data-testid="node-delete"
              onClick={(e) => {
                e.stopPropagation();
                // 删除节点前明确处理关联道路：必须让用户知情，不能留下悬空引用
                const connected = roads.filter(
                  (r) => r.fromNodeId === node.id || r.toNodeId === node.id,
                );
                const message =
                  connected.length > 0
                    ? `节点“${node.name}”关联了 ${connected.length} 条道路。\n删除该节点会同时删除这些道路，是否继续？`
                    : `确定删除节点“${node.name}”吗？`;
                if (!window.confirm(message)) return;
                const result = deleteNode(node.id);
                if (!result.ok) {
                  pushNotice('error', result.error ?? '删除节点失败');
                  return;
                }
                pushNotice(
                  'info',
                  result.removedRoads > 0
                    ? `已删除节点“${node.name}”及关联的 ${result.removedRoads} 条道路`
                    : `已删除节点“${node.name}”`,
                );
              }}
            >
              删除
            </button>
          </div>
        )}
      </div>

      {error && (
        <p className={styles.error} role="alert" onClick={(e) => e.stopPropagation()}>
          {error}
        </p>
      )}
    </li>
  );
}
