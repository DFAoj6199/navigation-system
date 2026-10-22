import type { MapNode, PixelPoint, Road } from '../types';

/**
 * 道路相关的纯函数（无副作用，便于单元测试与后续寻路阶段复用）。
 *
 * 坐标系与节点一致：全部为原始图片像素坐标。
 * 道路几何为“端点节点 -> 中间点... -> 端点节点”的有序点列，
 * 中间点数量不固定，不做任何直线简化。
 */

const ROAD_ID_PREFIX = 'road';

export function createRoadId(): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `${ROAD_ID_PREFIX}-${Date.now().toString(36)}-${random}`;
}

/** 构建一条完整道路（points 为中间点，不含端点） */
export function createRoad(
  fromNodeId: string,
  toNodeId: string,
  points: PixelPoint[],
  name?: string,
): Road {
  return {
    id: createRoadId(),
    name: name?.trim() || undefined,
    fromNodeId,
    toNodeId,
    points: points.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })),
    createdAt: new Date().toISOString(),
  };
}

/** 两端点 id 的无序键，用于判断“同一对节点之间的道路” */
export function roadPairKey(nodeAId: string, nodeBId: string): string {
  return [nodeAId, nodeBId].sort().join('|');
}

/** 判断两条道路是否连接同一对节点（忽略方向） */
export function isSameNodePair(road: Road, nodeAId: string, nodeBId: string): boolean {
  return roadPairKey(road.fromNodeId, road.toNodeId) === roadPairKey(nodeAId, nodeBId);
}

/**
 * 生成道路上除端点之外的全部几何点（渲染与距离计算共用）。
 * 返回：中间点数组（按 from -> to 顺序）。
 * 注意：端点坐标不在此函数中返回，必须由调用方从节点实时读取，
 * 这样节点移动时折线端点会自动跟随，保证“始终与正确端点相连”。
 */
export function roadIntermediatePoints(road: Road): PixelPoint[] {
  return road.points.map((p) => ({ x: p.x, y: p.y }));
}

/**
 * 组装道路完整折线：起点节点坐标 + 中间点 + 终点节点坐标。
 * 端点由节点实时提供，避免存储冗余导致的错位。
 */
export function buildRoadPolyline(road: Road, fromNode: PixelPoint, toNode: PixelPoint): PixelPoint[] {
  return [{ x: fromNode.x, y: fromNode.y }, ...roadIntermediatePoints(road), { x: toNode.x, y: toNode.y }];
}

/** 把折线点列转换为 SVG points 属性字符串 */
export function polylineToSvgPoints(points: PixelPoint[]): string {
  return points.map((p) => `${p.x},${p.y}`).join(' ');
}

/** 折线的像素长度（按原图像素单位） */
export function polylineLength(points: PixelPoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return total;
}

/** 两个点之间的像素距离 */
export function distance(a: PixelPoint, b: PixelPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 判断点是否在地图范围内（含边界） */
export function isPointInside(point: PixelPoint, width: number, height: number): boolean {
  return point.x >= 0 && point.x <= width && point.y >= 0 && point.y <= height;
}

export type RoadValidationResult = { ok: true } | { ok: false; error: string };

/**
 * 校验创建道路的输入。
 * - 端点必须已选且不相同；
 * - 端点必须是已存在的节点；
 * - 不能与已有道路重复连接同一对节点；
 * - 所有中间点必须在地图范围内。
 */
export function validateNewRoad(
  fromNodeId: string | null,
  toNodeId: string | null,
  points: PixelPoint[],
  nodes: MapNode[],
  roads: Road[],
  imageWidth: number,
  imageHeight: number,
): RoadValidationResult {
  if (!fromNodeId || !toNodeId) {
    return { ok: false, error: '请选择道路的两个端点节点' };
  }
  if (fromNodeId === toNodeId) {
    return { ok: false, error: '道路的两个端点不能是同一个节点' };
  }
  const fromExists = nodes.some((n) => n.id === fromNodeId);
  const toExists = nodes.some((n) => n.id === toNodeId);
  if (!fromExists || !toExists) {
    return { ok: false, error: '端点节点不存在，可能已被删除' };
  }
  if (roads.some((r) => isSameNodePair(r, fromNodeId, toNodeId))) {
    return { ok: false, error: '这两个节点之间已存在道路，如需调整请编辑或重新绘制该道路' };
  }
  for (let i = 0; i < points.length; i += 1) {
    if (!isPointInside(points[i], imageWidth, imageHeight)) {
      return {
        ok: false,
        error: `第 ${i + 1} 个中间点 (${Math.round(points[i].x)}, ${Math.round(points[i].y)}) 超出地图范围`,
      };
    }
  }
  return { ok: true };
}

/** 自动道路名称：优先由调用方用两端节点名拼接 */
export function composeRoadName(fromName: string, toName: string): string {
  return `${fromName} ⇄ ${toName}`;
}

/** 统计与某个节点关联的道路数量 */
export function roadsConnectedTo(nodeId: string, roads: Road[]): Road[] {
  return roads.filter((r) => r.fromNodeId === nodeId || r.toNodeId === nodeId);
}

/**
 * 删除节点时，计算受影响的道路。
 * 返回需要一并删除的道路与它们的描述，供 UI 明确告知用户，避免悬空引用。
 */
export function roadsAffectedByNodeDeletion(nodeId: string, roads: Road[]): Road[] {
  return roadsConnectedTo(nodeId, roads);
}

/** 道路显示名：优先使用自定义名称，否则用两端节点名 */
export function roadDisplayName(road: Road, nodes: MapNode[]): string {
  if (road.name) return road.name;
  const from = nodes.find((n) => n.id === road.fromNodeId);
  const to = nodes.find((n) => n.id === road.toNodeId);
  return `${from?.name ?? '未知节点'} ⇄ ${to?.name ?? '未知节点'}`;
}

/** 检查道路上是否存在悬空引用（端点节点已被删除） */
export function findDanglingRoads(roads: Road[], nodes: MapNode[]): Road[] {
  const ids = new Set(nodes.map((n) => n.id));
  return roads.filter((r) => !ids.has(r.fromNodeId) || !ids.has(r.toNodeId));
}
