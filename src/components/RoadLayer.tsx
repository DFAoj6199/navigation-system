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
            {/* 双向道路：在中点位置绘制一对方向相反的箭头，直观表达“双向” */}
            <g className={styles.arrows} data-testid="road-bidirectional-marker">
              {renderBidirectionalMarkers(polyline, zoom, isSelected ? '#b45309' : '#0f766e')}
            </g>
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
          <g data-testid="draft-arrows">{renderBidirectionalMarkers(draftPolyline, zoom, '#2563eb')}</g>
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

/**
 * 在折线中点处绘制“双向”箭头标记：一对指向相反方向的箭头。
 * 尺寸按 zoom 反向补偿，保证屏幕上大小恒定。
 */
function renderBidirectionalMarkers(polyline: PixelPoint[], zoom: number, color = '#0f766e') {
  if (polyline.length < 2) return null;
  // 取折线中点所在的那一段
  const segment = pickMiddleSegment(polyline);
  if (!segment) return null;
  const { a, b } = segment;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return null;
  const ux = dx / len;
  const uy = dy / len;
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };

  const size = 8 / zoom;
  const gap = 7 / zoom;

  return (
    <>
      {[-1, 1].map((direction) => {
        const tip = { x: mid.x + ux * direction * gap, y: mid.y + uy * direction * gap };
        const back = { x: tip.x - ux * direction * size * 1.5, y: tip.y - uy * direction * size * 1.5 };
        const left = { x: back.x - uy * size * 0.75, y: back.y + ux * size * 0.75 };
        const right = { x: back.x + uy * size * 0.75, y: back.y - ux * size * 0.75 };
        return (
          <polygon
            key={direction}
            points={`${tip.x},${tip.y} ${left.x},${left.y} ${right.x},${right.y}`}
            fill={color}
            stroke="#ffffff"
            strokeWidth={1.5 / zoom}
          />
        );
      })}
    </>
  );
}

/** 选出折线按长度计的中段，用于放置箭头标记 */
function pickMiddleSegment(polyline: PixelPoint[]): { a: PixelPoint; b: PixelPoint } | null {
  const lengths: number[] = [];
  let total = 0;
  for (let i = 1; i < polyline.length; i += 1) {
    const d = Math.hypot(polyline[i].x - polyline[i - 1].x, polyline[i].y - polyline[i - 1].y);
    lengths.push(d);
    total += d;
  }
  if (total < 1e-6) return null;
  const half = total / 2;
  let acc = 0;
  for (let i = 0; i < lengths.length; i += 1) {
    if (acc + lengths[i] >= half) {
      return { a: polyline[i], b: polyline[i + 1] };
    }
    acc += lengths[i];
  }
  return { a: polyline[polyline.length - 2], b: polyline[polyline.length - 1] };
}
