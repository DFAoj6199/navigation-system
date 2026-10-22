import { useMemo, useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import {
  LENGTH_UNIT,
  formatNodeSequence,
  formatPixelLength,
  type PathResult,
} from '../lib/pathfinding';
import { formatDistance } from '../lib/scale';
import styles from './PathPanel.module.css';

/**
 * 路径搜索面板。
 *
 * 说明：
 * - 未校准时长度只能是“原始图像像素”，绝不标注为米；
 * - 已校准时只显示实际长度（米/千米），不再显示像素数值；
 * - 每条道路的长度按完整折线（含全部中间点）累加，不是端点直线距离；
 * - 简单路径可能极多，结果有数量上限；被截断时界面明确标注“非完整结果”。
 */
export function PathPanel() {
  const nodes = useAppStore((s) => s.nodes);
  const image = useAppStore((s) => s.image);
  const startNodeId = useAppStore((s) => s.startNodeId);
  const endNodeId = useAppStore((s) => s.endNodeId);
  const search = useAppStore((s) => s.search);
  const searchLimits = useAppStore((s) => s.searchLimits);
  const scale = useAppStore((s) => s.scale);
  const setStartNodeId = useAppStore((s) => s.setStartNodeId);
  const setEndNodeId = useAppStore((s) => s.setEndNodeId);
  const setSearchLimits = useAppStore((s) => s.setSearchLimits);
  const runSearch = useAppStore((s) => s.runSearch);
  const highlightPath = useAppStore((s) => s.highlightPath);
  const pushNotice = useAppStore((s) => s.pushNotice);

  const [localError, setLocalError] = useState<string | null>(null);

  const canSearch = Boolean(image) && nodes.length >= 1;

  const handleSearch = () => {
    setLocalError(null);
    const result = runSearch();
    if (!result.ok) {
      setLocalError(result.error ?? '搜索失败');
      return;
    }
    const state = useAppStore.getState().search;
    if (state.status === 'no-path') {
      pushNotice('info', '当前无路径');
    } else if (state.simple && state.simple.complete) {
      pushNotice('success', `共找到 ${state.simple.paths.length} 条简单路径`);
    } else if (state.simple) {
      pushNotice('info', `结果已达到上限，返回前 ${state.simple.paths.length} 条（非全部路径）`);
    }
  };

  const swap = () => {
    const s = useAppStore.getState().startNodeId;
    const e = useAppStore.getState().endNodeId;
    setStartNodeId(e);
    setEndNodeId(s);
  };

  /** 结果排序：按长度升序，长度相同按节点序列稳定排序 */
  const sortedPaths = useMemo(() => {
    if (!search.simple) return [];
    return [...search.simple.paths].sort((a, b) => {
      if (a.length !== b.length) return a.length - b.length;
      return a.nodeIds.join('>').localeCompare(b.nodeIds.join('>'));
    });
  }, [search.simple]);

  /** 本次搜索实际使用的起终点名称（来自结果快照，不受下拉框后续改动影响） */
  const searchedStartName =
    nodes.find((n) => n.id === search.searchedStartId)?.name ?? '（已删除）';
  const searchedEndName =
    nodes.find((n) => n.id === search.searchedEndId)?.name ?? '（已删除）';
  const showSearchInfo = search.status === 'found' || search.status === 'no-path';

  const isHighlighted = (path: PathResult) =>
    path.roadIds.length === search.highlightedRoadIds.length &&
    path.roadIds.every((id, i) => id === search.highlightedRoadIds[i]);

  if (!image) {
    return (
      <section className={styles.panel} aria-labelledby="path-panel-heading" data-testid="path-panel">
        <h2 id="path-panel-heading" className={styles.heading}>路径搜索</h2>
        <p className={styles.empty}>上传底图并添加节点、道路后，才能搜索路径。</p>
      </section>
    );
  }

  return (
    <section className={styles.panel} aria-labelledby="path-panel-heading" data-testid="path-panel">
      <div className={styles.headingRow}>
        <h2 id="path-panel-heading" className={styles.heading}>路径搜索</h2>
        <span className={scale ? styles.unitHintOk : styles.unitHint} data-testid="length-unit">
          {scale ? '长度单位：米（已校准）' : `长度单位：${LENGTH_UNIT}（未校准）`}
        </span>
      </div>

      <p className={styles.desc}>
        只使用已有的<strong>双向</strong>道路。道路长度按<strong>完整折线</strong>（含全部中间点）逐段累加。
        {scale ? (
          <>已校准比例尺，长度直接以<strong>米/千米</strong>显示（不再显示像素数值）。</>
        ) : (
          <>
            比例尺<strong>未校准</strong>，因此只显示<strong>像素</strong>长度，不代表实际米数；
            请到“比例尺”页签完成校准。
          </>
        )}
      </p>

      {nodes.length === 0 ? (
        <p className={styles.warn} data-testid="path-need-nodes">
          还没有节点，请先在“节点管理”中添加节点并绘制道路。
        </p>
      ) : (
        <>
          <div className={styles.endpointRow}>
            <label className={styles.field}>
              <span className={styles.label}>起点</span>
              <select
                value={startNodeId}
                disabled={!canSearch}
                data-testid="path-start-select"
                onChange={(e) => {
                  setLocalError(null);
                  setStartNodeId(e.target.value);
                }}
              >
                <option value="">请选择…</option>
                {nodes.map((n) => (
                  <option key={n.id} value={n.id}>{n.name}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className={styles.swapButton}
              onClick={swap}
              disabled={!startNodeId && !endNodeId}
              title="交换起点与终点"
              data-testid="path-swap"
            >
              ⇄
            </button>
            <label className={styles.field}>
              <span className={styles.label}>终点</span>
              <select
                value={endNodeId}
                disabled={!canSearch}
                data-testid="path-end-select"
                onChange={(e) => {
                  setLocalError(null);
                  setEndNodeId(e.target.value);
                }}
              >
                <option value="">请选择…</option>
                {nodes.map((n) => (
                  <option key={n.id} value={n.id}>{n.name}</option>
                ))}
              </select>
            </label>
          </div>

          <div className={styles.limitRow}>
            <label className={styles.limitField}>
              <span className={styles.label}>最大结果数</span>
              <input
                type="number"
                min={1}
                max={5000}
                value={searchLimits.maxResults}
                data-testid="path-max-results"
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v) && v >= 1) setSearchLimits({ maxResults: Math.floor(v) });
                }}
              />
            </label>
            <button
              type="button"
              className={styles.searchButton}
              onClick={handleSearch}
              disabled={!canSearch}
              data-testid="path-search"
            >
              开始搜索
            </button>
          </div>

          {(localError || search.error) && (
            <p className={styles.error} role="alert" data-testid="path-error">
              {localError ?? search.error}
            </p>
          )}

          {showSearchInfo && (
            <div className={styles.searchInfo} data-testid="path-search-info">
              <span className={styles.infoItem} data-testid="path-info-start">
                <span className={styles.infoDotStart} aria-hidden="true" />
                起点：<strong>{searchedStartName}</strong>
              </span>
              <span className={styles.infoArrow} aria-hidden="true">
                →
              </span>
              <span className={styles.infoItem} data-testid="path-info-end">
                <span className={styles.infoDotEnd} aria-hidden="true" />
                终点：<strong>{searchedEndName}</strong>
              </span>
            </div>
          )}

          {search.sameEndpoint && (
            <div className={styles.sameBox} data-testid="path-same-endpoint">
              起点与终点相同：按约定返回 1 条仅含该节点、长度为 0 的路径。
            </div>
          )}

          {search.status === 'no-path' && (
            <div className={styles.noPath} data-testid="path-no-result">
              当前无路径
            </div>
          )}

          {search.status === 'found' && search.simple && (
            <>
              <div className={styles.summary} data-testid="path-summary">
                <span className={styles.count} data-testid="path-count">
                  共 {search.simple.paths.length} 条路径
                </span>
                {!search.sameEndpoint && (
                  <span
                    className={search.simple.complete ? styles.completeTag : styles.partialTag}
                    data-testid="path-completeness"
                    data-complete={search.simple.complete ? 'true' : 'false'}
                  >
                    {search.simple.complete ? '完整结果（已穷举全部简单路径）' : '非完整结果（已达到上限）'}
                  </span>
                )}
              </div>

              {!search.simple.complete && (
                <p className={styles.truncNote} data-testid="path-truncated-note">
                  {search.simple.truncatedReason === 'maxResults'
                    ? `已达到“最大结果数 ${search.limits.maxResults}”的限制，仅列出前 ${search.simple.paths.length} 条，并非全部路径。`
                    : `搜索展开次数达到安全上限（${search.limits.maxExpansions} 次），结果不完整，并非全部路径。`}
                </p>
              )}

              {search.shortest && !search.sameEndpoint && (
                <div className={styles.shortestBox} data-testid="path-shortest">
                  <div className={styles.shortestTitle}>最短路径</div>
                  <div className={styles.shortestSeq} data-testid="shortest-sequence">
                    {formatNodeSequence(search.shortest.nodeIds, nodes)}
                  </div>
                  <div className={styles.shortestLen} data-testid="shortest-length">
                    {search.shortest.meters !== null
                      ? `长度 ${formatDistance(search.shortest.meters)}`
                      : `长度 ${formatPixelLength(search.shortest.length)}`}
                  </div>
                </div>
              )}

              <ul className={styles.list} data-testid="path-list">
                {sortedPaths.map((path, index) => (
                  <li
                    key={`${path.nodeIds.join('-')}-${index}`}
                    className={[styles.item, isHighlighted(path) ? styles.itemActive : ''].join(' ')}
                    data-testid="path-item"
                    data-index={index}
                    data-node-count={path.nodeIds.length}
                    data-length={path.length.toFixed(3)}
                    onClick={() => highlightPath(path)}
                    title="点击在地图上高亮该路线"
                  >
                    <span className={styles.order}>#{index + 1}</span>
                    <span className={styles.sequence} data-testid="path-sequence">
                      {formatNodeSequence(path.nodeIds, nodes)}
                    </span>
                    <span className={styles.length} data-testid="path-item-length">
                      {path.meters !== null
                        ? formatDistance(path.meters)
                        : formatPixelLength(path.length)}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {search.status === 'idle' && (
            <p className={styles.hint}>选择起点与终点后点击“开始搜索”。</p>
          )}
        </>
      )}
    </section>
  );
}
