import { useMemo } from 'react';
import type { MapNode, PixelPoint, Road } from '../types';
import { buildRoadPolyline, polylineToSvgPoints } from '../lib/roads';
import styles from './RoadLayer.module.css';

interface RoadLayerProps {
  roads: Road[];
  nodes: MapNode[];
  zoom: number;
  selectedRoadId: string | null;
  /** 草稿中的中间点（正在绘制时） */
  draftPoints: PixelPoint[];
  /** 草稿端点节点（正在绘制时） */
  draftFromNodeId?: string;
  draftToNodeId?: string;
  /** 是否允许拖动中间点 */
  editable: boolean;
  /** 当前寻路结果高亮所经过的道路 id（只读，不修改任何道路数据） */
  highlightedRoadIds: string[];
  onSelectRoad: (roadId: string) => void;
  onDragPointStart: (event: React.PointerEvent<SVGCircleElement>, roadId: string, index: number) => void;
  onDragDraftPointStart: (event: React.PointerEvent<SVGCircleElement>, index: number) => void;
}

/**
 * 道路图层。
 *
 * 坐标说明：本组件整体位于与底图相同的 SVG 坐标系内（viewBox = 原始像素尺寸），
 * 因此每个点直接用原始图片像素坐标绘制，缩放/拖动由父层 transform 统一处理，
 * 折线必然与道路位置对齐，不会出现“只按屏幕坐标绘制”的漂移问题。
 *
 * 线宽、圆点半径均按 1/zoom 反向补偿，保证屏幕上视觉尺寸恒定、便于点击。
 */
export function RoadLayer({
  roads,
  nodes,
  zoom,
  selectedRoadId,
  draftPoints,
  draftFromNodeId,
  draftToNodeId,
  editable,
  highlightedRoadIds,
  onSelectRoad,
  onDragPointStart,
  onDragDraftPointStart,
}: RoadLayerProps) {
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  // 正在绘制的草稿折线：起点节点 -> 中间点 -> 终点节点
  const draftPolyline = useMemo(() => {
    if (!draftFromNodeId || !draftToNodeId) return null;
    const from = nodeById.get(draftFromNodeId);
    const to = nodeById.get(draftToNodeId);
    if (!from || !to) return null;
    return [{ x: from.point.x, y: from.point.y }, ...draftPoints, { x: to.point.x, y: to.point.y }];
  }, [draftFromNodeId, draftToNodeId, draftPoints, nodeById]);

  // 高亮集合：只用于渲染判断，绝不修改 roads 数据
  const highlightedSet = useMemo(() => new Set(highlightedRoadIds), [highlightedRoadIds]);

  const handleR = 5 / zoom;
  const draftHandleR = 6 / zoom;
  const lineWidth = 4 / zoom;
  const selectedLineWidth = 6 / zoom;

  return (
    <g className={styles.root} data-testid="road-layer">
      {roads.map((road) => {
        const from = nodeById.get(road.fromNodeId);
        const to = nodeById.get(road.toNodeId);
        if (!from || !to) {
          // 防御：正常情况下 store 已保证不会出现悬空引用
          return null;
        }
        const polyline = buildRoadPolyline(road, from.point, to.point);
        const pointsAttr = polylineToSvgPoints(polyline);
        const isSelected = road.id === selectedRoadId;
        const isHighlighted = highlightedSet.has(road.id);

        return (
          <g
            key={road.id}
            data-road-id={road.id}
            data-road-line="true"
            data-point-count={road.points.length}
            data-points={pointsAttr}
            data-road-highlighted={isHighlighted ? 'true' : 'false'}
            className={styles.roadGroup}
          >
            {/* 透明加宽命中区，便于点选 */}
            <polyline
              points={pointsAttr}
              fill="none"
              stroke="transparent"
              strokeWidth={16 / zoom}
              strokeLinecap="round"
              strokeLinejoin="round"
              className={styles.hitArea}
              onPointerDown={(event) => {
                event.stopPropagation();
                onSelectRoad(road.id);
              }}
            />
            {/* 寻路结果高亮：复用本道路的真实折线坐标（含全部中间点），
                不另外在两端点之间画直线，保证与底层道路完全重合 */}
            {isHighlighted && (
              <>
                <polyline
                  points={pointsAttr}
                  fill="none"
                  stroke="#ffffff"
                  strokeWidth={12 / zoom}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity={0.9}
                />
                <polyline
                  points={pointsAttr}
                  fill="none"
                  stroke="#7c3aed"
                  strokeWidth={7 / zoom}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeDasharray={`${16 / zoom} ${7 / zoom}`}
                  className={styles.highlightedLine}
                  data-testid="road-highlight-line"
                />
              </>
            )}
            {/* 选中时的外发光描边 */}
            {isSelected && (
              <polyline
                points={pointsAttr}
                fill="none"
                stroke="#fbbf24"
                strokeWidth={selectedLineWidth + 5 / zoom}
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity={0.55}
              />
            )}
            <polyline
              points={pointsAttr}
              fill="none"
              stroke={isSelected ? '#b45309' : '#0f766e'}
              strokeWidth={isSelected ? selectedLineWidth : lineWidth}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {/* 中间点手柄（可拖动编辑） */}
            {road.points.map((point, index) => (
              <circle
                key={`${road.id}-p-${index}`}
                cx={point.x}
                cy={point.y}
                r={handleR}
                fill="#ffffff"
                stroke={isSelected ? '#b45309' : '#0f766e'}
                strokeWidth={2 / zoom}
                className={editable ? styles.pointHandle : styles.pointHandleStatic}
                data-road-point={road.id}
                data-point-index={index}
                data-pixel-x={point.x}
                data-pixel-y={point.y}
                onPointerDown={(event) => {
                  if (!editable) return;
                  onDragPointStart(event, road.id, index);
                }}
              />
            ))}
          </g>
        );
      })}

      {/* 绘制中的草稿折线 */}
      {draftPolyline && (
        <g data-testid="draft-road" data-point-count={draftPoints.length} data-points={polylineToSvgPoints(draftPolyline)}>
          <polyline
            points={polylineToSvgPoints(draftPolyline)}
            fill="none"
            stroke="#2563eb"
            strokeWidth={selectedLineWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray={`${10 / zoom} ${6 / zoom}`}
          />
          {draftPoints.map((point, index) => (
            <circle
              key={`draft-${index}`}
              cx={point.x}
              cy={point.y}
              r={draftHandleR}
              fill="#dbeafe"
              stroke="#2563eb"
              strokeWidth={2 / zoom}
              className={styles.pointHandle}
              data-draft-point="true"
              data-point-index={index}
              data-pixel-x={point.x}
              data-pixel-y={point.y}
              onPointerDown={(event) => onDragDraftPointStart(event, index)}
            />
          ))}
        </g>
      )}
    </g>
  );
}
