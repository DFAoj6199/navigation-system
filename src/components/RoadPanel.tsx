import { useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import type { MapMode } from './MapViewport';
import { roadDisplayName } from '../lib/roads';
import styles from './RoadPanel.module.css';

interface RoadPanelProps {
  /** 由 App 控制地图交互模式，用于进入/退出绘制模式 */
  mode: MapMode;
  setMode: (mode: MapMode) => void;
}

/**
 * 道路管理面板（仅在“节点管理 / 道路管理”模式下显示）。
 *
 * 流程：
 *   1. 选择两个已存在节点作为端点；
 *   2. 点击“绘制道路”进入绘制模式；
 *   3. 在地图上连续单击添加中间点（数量不限）；
 *   4. “完成绘制”落库 / “取消绘制”放弃 / “重新绘制”替换中间点。
 */
export function RoadPanel({ mode, setMode }: RoadPanelProps) {
  const image = useAppStore((s) => s.image);
  const nodes = useAppStore((s) => s.nodes);
  const roads = useAppStore((s) => s.roads);
  const draft = useAppStore((s) => s.draft);
  const selectedRoadId = useAppStore((s) => s.selectedRoadId);
  const startRoadDraft = useAppStore((s) => s.startRoadDraft);
  const startRedrawRoad = useAppStore((s) => s.startRedrawRoad);
  const commitRoadDraft = useAppStore((s) => s.commitRoadDraft);
  const cancelRoadDraft = useAppStore((s) => s.cancelRoadDraft);
  const undoDraftPoint = useAppStore((s) => s.undoDraftPoint);
  const clearDraftPoints = useAppStore((s) => s.clearDraftPoints);
  const deleteRoad = useAppStore((s) => s.deleteRoad);
  const selectRoad = useAppStore((s) => s.selectRoad);
  const renameRoad = useAppStore((s) => s.renameRoad);
  const pushNotice = useAppStore((s) => s.pushNotice);

  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const canStart = Boolean(image) && nodes.length >= 2;

  const handleStart = () => {
    setError(null);
    const result = startRoadDraft(fromId, toId);
    if (!result.ok) {
      setError(result.error ?? '无法开始绘制');
      return;
    }
    setMode('draw');
    pushNotice('info', '已进入道路绘制模式，请在地图上连续单击添加中间点');
  };

  const handleCommit = () => {
    setError(null);
    const result = commitRoadDraft();
    if (!result.ok) {
      setError(result.error ?? '完成绘制失败');
      return;
    }
    setMode('pan');
    const fromName = nodes.find((n) => n.id === draft?.fromNodeId)?.name ?? '';
    const toName = nodes.find((n) => n.id === draft?.toNodeId)?.name ?? '';
    pushNotice(
      'success',
      result.replaced
        ? `道路“${fromName} ⇄ ${toName}”已重新绘制（${draft?.points.length ?? 0} 个中间点）`
        : `已创建双向道路“${fromName} ⇄ ${toName}”（${draft?.points.length ?? 0} 个中间点）`,
    );
  };

  const handleCancel = () => {
    setError(null);
    cancelRoadDraft();
    setMode('pan');
    pushNotice('info', '已取消道路绘制');
  };

  const handleRedraw = (roadId: string) => {
    setError(null);
    const result = startRedrawRoad(roadId);
    if (!result.ok) {
      setError(result.error ?? '无法重新绘制');
      return;
    }
    setMode('draw');
    pushNotice('info', '重新绘制：请在地图上重新点击中间点，完成后点“完成绘制”');
  };

  if (!image) {
    return (
      <section className={styles.panel} aria-labelledby="road-panel-heading" data-testid="road-panel">
        <h2 id="road-panel-heading" className={styles.heading}>道路管理</h2>
        <p className={styles.empty}>上传底图并添加至少两个节点后，才能绘制道路。</p>
      </section>
    );
  }

  return (
    <section className={styles.panel} aria-labelledby="road-panel-heading" data-testid="road-panel">
      <div className={styles.headingRow}>
        <h2 id="road-panel-heading" className={styles.heading}>道路管理</h2>
        <span className={styles.count} data-testid="road-count">共 {roads.length} 条</span>
      </div>
      <p className={styles.desc}>
        所有道路均为<strong>双向</strong>。折线由“起点节点 → 多个中间点 → 终点节点”组成，中间点数量不限。
      </p>

      {nodes.length < 2 && (
        <p className={styles.warn} data-testid="road-need-nodes">
          至少需要 2 个节点才能绘制道路，请先在“节点管理”中添加节点。
        </p>
      )}

      {!draft && (
        <div className={styles.startBox}>
          <div className={styles.endpointRow}>
            <label className={styles.field}>
              <span className={styles.label}>起点节点</span>
              <select
                value={fromId}
                disabled={!canStart}
                data-testid="road-from-select"
                onChange={(e) => {
                  setFromId(e.target.value);
                  setError(null);
                }}
              >
                <option value="">请选择…</option>
                {nodes.map((n) => (
                  <option key={n.id} value={n.id}>{n.name}</option>
                ))}
              </select>
            </label>
            <span className={styles.arrow} aria-hidden="true">⇄</span>
            <label className={styles.field}>
              <span className={styles.label}>终点节点</span>
              <select
                value={toId}
                disabled={!canStart}
                data-testid="road-to-select"
                onChange={(e) => {
                  setToId(e.target.value);
                  setError(null);
                }}
              >
                <option value="">请选择…</option>
                {nodes.map((n) => (
                  <option key={n.id} value={n.id}>{n.name}</option>
                ))}
              </select>
            </label>
          </div>
          <button
            type="button"
            className={styles.primaryButton}
            disabled={!canStart}
            onClick={handleStart}
            data-testid="road-draw-start"
          >
            绘制道路
          </button>
        </div>
      )}

      {draft && (
        <div className={styles.draftBox} data-testid="road-draft-box">
          <div className={styles.draftHeader}>
            <span className={styles.draftTitle}>
              {draft.editingRoadId ? '重新绘制中' : '绘制中'}
            </span>
            <span className={styles.draftCount} data-testid="draft-point-count">
              中间点 {draft.points.length} 个
            </span>
          </div>
          <p className={styles.draftPath}>
            {nodes.find((n) => n.id === draft.fromNodeId)?.name ?? '?'}
            <span className={styles.pathArrow}> → </span>
            <span className={styles.pathMid}>{draft.points.length} 个中间点</span>
            <span className={styles.pathArrow}> → </span>
            {nodes.find((n) => n.id === draft.toNodeId)?.name ?? '?'}
          </p>
          <div className={styles.draftActions}>
            <button
              type="button"
              className={styles.primaryButton}
              onClick={handleCommit}
              data-testid="road-draw-commit"
            >
              完成绘制
            </button>
            <button type="button" onClick={handleCancel} data-testid="road-draw-cancel">取消绘制</button>
            <button
              type="button"
              onClick={() => undoDraftPoint()}
              disabled={draft.points.length === 0}
              data-testid="road-draw-undo"
            >
              撤销上一点
            </button>
            <button
              type="button"
              onClick={() => clearDraftPoints()}
              disabled={draft.points.length === 0}
              data-testid="road-draw-clear"
            >
              清空中间点
            </button>
          </div>
          {mode !== 'draw' && (
            <button type="button" className={styles.resumeButton} onClick={() => setMode('draw')}>
              继续在地图上点击添加中间点
            </button>
          )}
          <p className={styles.hint}>
            提示：中间点可以为 0 个（两点直连）；也可以连续点击任意多个中间点来贴合实际道路走向。
          </p>
        </div>
      )}

      {error && (
        <p className={styles.error} role="alert" data-testid="road-error">{error}</p>
      )}

      {roads.length === 0 ? (
        <p className={styles.empty} data-testid="road-list-empty">
          还没有道路。选择两个节点后点击“绘制道路”即可创建。
        </p>
      ) : (
        <ul className={styles.list} data-testid="road-list">
          {roads.map((road, index) => {
            const isSelected = road.id === selectedRoadId;
            const from = nodes.find((n) => n.id === road.fromNodeId);
            const to = nodes.find((n) => n.id === road.toNodeId);
            return (
              <li
                key={road.id}
                className={[styles.item, isSelected ? styles.itemSelected : ''].join(' ')}
                data-testid="road-item"
                data-road-id={road.id}
                data-point-count={road.points.length}
                onClick={() => selectRoad(road.id)}
              >
                <div className={styles.itemHeader}>
                  <span className={styles.order}>#{index + 1}</span>
                  <span className={styles.bidirectional} title="双向道路">⇄</span>
                  <span className={styles.roadName} title={roadDisplayName(road, nodes)}>
                    {roadDisplayName(road, nodes)}
                  </span>
                </div>
                <div className={styles.itemMeta}>
                  <span
                    className={styles.pointCount}
                    data-testid="road-point-count"
                    data-points={road.points.map((p) => `${p.x},${p.y}`).join(' ')}
                  >
                    中间点 {road.points.length} 个
                  </span>
                  <span className={styles.coordList}>
                    {road.points.slice(0, 3).map((p, i) => (
                      <span key={i}>({p.x},{p.y})</span>
                    ))}
                    {road.points.length > 3 && <span>…</span>}
                  </span>
                </div>
                <div className={styles.actions} onClick={(e) => e.stopPropagation()}>
                  <button type="button" onClick={() => handleRedraw(road.id)} data-testid="road-redraw">
                    重新绘制
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const current = road.name ?? '';
                      const next = window.prompt('修改道路名称（留空则使用两端节点名）', current);
                      if (next === null) return;
                      const result = renameRoad(road.id, next);
                      if (!result.ok) {
                        setError(result.error ?? '改名失败');
                      } else {
                        pushNotice('success', '道路名称已更新');
                      }
                    }}
                  >
                    改名
                  </button>
                  <button
                    type="button"
                    className={styles.deleteButton}
                    data-testid="road-delete"
                    onClick={() => {
                      if (!window.confirm(`确定删除道路“${roadDisplayName(road, nodes)}”吗？`)) return;
                      deleteRoad(road.id);
                      pushNotice('info', '已删除道路');
                    }}
                  >
                    删除
                  </button>
                </div>
                <div className={styles.endpoints}>
                  端点：{from?.name ?? '?'} ⇄ {to?.name ?? '?'}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
