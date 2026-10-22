import type { MapNode, Road } from '../types';
import { buildRoadPolyline, distance, polylineLength } from './roads';
import { pixelsToMeters, type MapScale } from './scale';

/**
 * 寻路相关的纯函数。
 *
 * 【关键约定】
 * 1. 所有道路均为双向：构建邻接表时同时建立 A->B 与 B->A 两条边。
 * 2. 边权 = 道路“完整折线”的像素总长度（起点节点 -> 中间点... -> 终点节点），
 *    不是两个端点之间的直线距离。比例尺未校准，因此单位恒为“像素”，绝不写成米。
 * 3. 本模块不修改任何输入数据（不新增/修改/删除道路与节点），只读取。
 * 4. 简单路径：路径上不允许重复经过同一节点（起点=终点时除外，见 findSimplePaths）。
 */

/** 邻接边：一条无向道路在某个方向上的表示 */
export interface GraphEdge {
  /** 对端节点 id */
  to: string;
  /** 道路 id */
  roadId: string;
  /** 该方向上的完整折线（从当前节点到对端节点） */
  polyline: { x: number; y: number }[];
  /** 折线像素总长度（边权） */
  length: number;
}

/** 邻接表：nodeId -> 边列表。顺序稳定，便于结果可复现。 */
export type Graph = Map<string, GraphEdge[]>;

/** 长度单位：比例尺未校准，只能是像素 */
export const LENGTH_UNIT = '像素';

/**
 * 构建无向图邻接表。
 *
 * - 双向：每条道路生成两条有向边；
 * - 长度按完整折线累加，含全部中间点；
 * - 端点节点不存在（悬空引用）的道路会被忽略，不会导致崩溃；
 * - 边的顺序按 roads 数组顺序稳定生成，保证同样的数据得到同样的搜索结果。
 */
export function buildGraph(nodes: MapNode[], roads: Road[]): Graph {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const graph: Graph = new Map();
  for (const node of nodes) graph.set(node.id, []);

  for (const road of roads) {
    const from = nodeById.get(road.fromNodeId);
    const to = nodeById.get(road.toNodeId);
    // 悬空引用：跳过，绝不因此创建任何边
    if (!from || !to) continue;
    // 防御：自环道路（同一节点两端）在阶段2已被禁止，这里再挡一次，
    // 避免自环让“简单路径”出现邻接节点相同的情况。
    if (from.id === to.id) continue;

    const polylineForward = buildRoadPolyline(road, from.point, to.point);
    const polylineBackward = [...polylineForward].reverse();
    const length = polylineLength(polylineForward);

    graph.get(from.id)!.push({
      to: to.id,
      roadId: road.id,
      polyline: polylineForward,
      length,
    });
    graph.get(to.id)!.push({
      to: from.id,
      roadId: road.id,
      polyline: polylineBackward,
      length,
    });
  }
  return graph;
}

/** 单条道路的像素长度（完整折线，含中间点） */
export function roadPixelLength(road: Road, from: MapNode, to: MapNode): number {
  return polylineLength(buildRoadPolyline(road, from.point, to.point));
}

/** 一条找到的路径 */
export interface PathResult {
  /** 依次经过的节点 id（含首尾），例如 [n1, n3, n5] */
  nodeIds: string[];
  /** 依次使用的道路 id */
  roadIds: string[];
  /** 像素总长度（各段道路折线长度之和，与比例尺无关） */
  length: number;
  /**
   * 实际距离（米）。未校准时为 null —— 绝不把像素长度当米。
   * 计算方式：length × metersPerPixel，其中 metersPerPixel 来自比例尺校准。
   */
  meters: number | null;
  /** 完整折线（用于地图高亮） */
  polyline: { x: number; y: number }[];
}

/** 搜索限制与完整性标记 */
export interface SearchLimits {
  /** 最多返回多少条路径（简单路径） */
  maxResults: number;
  /** DFS 最多展开多少个节点（防止指数爆炸卡死页面） */
  maxExpansions: number;
}

export const DEFAULT_SEARCH_LIMITS: SearchLimits = {
  maxResults: 200,
  maxExpansions: 200_000,
};

/** 简单路径搜索结果 */
export interface SimplePathSearchResult {
  /** 路径列表（按找到顺序，长度升序由调用方决定是否排序） */
  paths: PathResult[];
  /** 是否因为达到上限而提前停止 */
  truncated: boolean;
  /** 截断原因，truncated=true 时必有值 */
  truncatedReason?: 'maxResults' | 'maxExpansions';
  /** 实际展开的节点次数 */
  expansions: number;
  /** 是否完整枚举了所有简单路径 */
  complete: boolean;
}

export type SearchOutcome =
  | { ok: true; result: SimplePathSearchResult }
  | { ok: false; error: string };

/** 起点与终点相同时的稳定处理：返回一条仅含起点的路径（长度 0），且标记为“起终点相同” */
export const SAME_ENDPOINT_NOTICE = '起点与终点相同：仅返回起终点为同一节点、长度为 0 的路径。';

/**
 * 枚举所有简单路径（DFS + 回溯）。
 *
 * 简单路径定义：路径中不重复经过同一个节点。
 * - 起点 === 终点：按稳定约定处理，返回单节点路径；
 * - 找不连通时返回空列表且 complete=true（“当前无路径”）；
 * - 达到 maxResults 或 maxExpansions 时 truncated=true、complete=false，
 *   绝不在 UI 上把部分结果说成全部路径。
 */
export function findAllSimplePaths(
  nodes: MapNode[],
  roads: Road[],
  startId: string,
  endId: string,
  limits: SearchLimits = DEFAULT_SEARCH_LIMITS,
  scale: MapScale | null = null,
): SearchOutcome {
  if (!startId || !endId) return { ok: false, error: '请选择起点和终点' };
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  if (!nodeById.has(startId)) return { ok: false, error: '起点节点不存在，可能已被删除' };
  if (!nodeById.has(endId)) return { ok: false, error: '终点节点不存在，可能已被删除' };

  // 起点=终点：稳定地为“一条零长度路径”，而不是空结果或无限递归
  if (startId === endId) {
    return {
      ok: true,
      result: {
        paths: [{ nodeIds: [startId], roadIds: [], length: 0, meters: pixelsToMeters(0, scale), polyline: [] }],
        truncated: false,
        expansions: 0,
        complete: true,
      },
    };
  }

  const graph = buildGraph(nodes, roads);
  const paths: PathResult[] = [];
  let expansions = 0;
  let truncatedReason: 'maxResults' | 'maxExpansions' | undefined;

  const visited = new Set<string>([startId]);
  const nodeStack: string[] = [startId];
  const roadStack: string[] = [];
  const polylineStack: { x: number; y: number }[] = [];

  const emit = (length: number) => {
    paths.push({
      nodeIds: [...nodeStack],
      roadIds: [...roadStack],
      length,
      meters: pixelsToMeters(length, scale),
      polyline: polylineStack.map((p) => ({ x: p.x, y: p.y })),
    });
  };

  /** 深度优先 + 回溯 */
  const dfs = (current: string, length: number): void => {
    if (truncatedReason) return;

    if (current === endId) {
      emit(length);
      if (paths.length >= limits.maxResults) truncatedReason = 'maxResults';
      return;
    }

    expansions += 1;
    if (expansions > limits.maxExpansions) {
      truncatedReason = 'maxExpansions';
      return;
    }

    for (const edge of graph.get(current) ?? []) {
      // 简单路径约束：不重复经过同一节点
      if (visited.has(edge.to)) continue;

      visited.add(edge.to);
      nodeStack.push(edge.to);
      roadStack.push(edge.roadId);
      // 追加该段折线（跳过首点，避免与上一段末点重复）
      const added = edge.polyline.slice(1);
      polylineStack.push(...added);

      dfs(edge.to, length + edge.length);

      // 回溯：恢复现场
      polylineStack.length -= added.length;
      roadStack.pop();
      nodeStack.pop();
      visited.delete(edge.to);

      if (truncatedReason) return;
    }
  };

  // 折线栈的起点就是起点节点本身（高亮时用）
  polylineStack.push({ x: nodeById.get(startId)!.point.x, y: nodeById.get(startId)!.point.y });
  dfs(startId, 0);

  return {
    ok: true,
    result: {
      paths,
      truncated: truncatedReason !== undefined,
      truncatedReason,
      expansions,
      complete: truncatedReason === undefined,
    },
  };
}

/** Dijkstra 结果 */
export interface ShortestPathResult {
  /** 找到的最短路径；不可达时为 null */
  path: PathResult | null;
  /** 访问/松弛的节点数，便于说明算法确实执行了 */
  settled: number;
}

export type ShortestOutcome =
  | { ok: true; result: ShortestPathResult }
  | { ok: false; error: string };

/**
 * Dijkstra 最短路径。
 *
 * 边权为道路完整折线的像素长度（非端点直线距离）。
 * 起点=终点时返回长度 0 的单节点路径（稳定约定，与简单路径一致）。
 */
export function findShortestPath(
  nodes: MapNode[],
  roads: Road[],
  startId: string,
  endId: string,
  scale: MapScale | null = null,
): ShortestOutcome {
  if (!startId || !endId) return { ok: false, error: '请选择起点和终点' };
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  if (!nodeById.has(startId)) return { ok: false, error: '起点节点不存在，可能已被删除' };
  if (!nodeById.has(endId)) return { ok: false, error: '终点节点不存在，可能已被删除' };

  if (startId === endId) {
    return {
      ok: true,
      result: {
        path: { nodeIds: [startId], roadIds: [], length: 0, meters: pixelsToMeters(0, scale), polyline: [] },
        settled: 1,
      },
    };
  }

  const graph = buildGraph(nodes, roads);

  const dist = new Map<string, number>();
  const prev = new Map<string, { node: string; edge: GraphEdge }>();
  const settledSet = new Set<string>();
  for (const node of nodes) dist.set(node.id, Infinity);
  dist.set(startId, 0);

  /** 取当前未确定节点中距离最小者（节点规模小，线性扫描足够且稳定） */
  const pickMin = (): string | null => {
    let best: string | null = null;
    let bestDist = Infinity;
    for (const [id, d] of dist) {
      if (settledSet.has(id)) continue;
      if (d < bestDist) {
        best = id;
        bestDist = d;
      }
    }
    return best;
  };

  let settled = 0;
  while (true) {
    const current = pickMin();
    if (!current) break;
    settledSet.add(current);
    settled += 1;
    if (current === endId) break;

    const currentDist = dist.get(current)!;
    for (const edge of graph.get(current) ?? []) {
      if (settledSet.has(edge.to)) continue;
      const candidate = currentDist + edge.length;
      if (candidate < (dist.get(edge.to) ?? Infinity)) {
        dist.set(edge.to, candidate);
        prev.set(edge.to, { node: current, edge });
      }
    }
  }

  if (!Number.isFinite(dist.get(endId) ?? Infinity)) {
    return { ok: true, result: { path: null, settled } };
  }

  // 回溯路径
  const nodeIds: string[] = [endId];
  const edges: GraphEdge[] = [];
  let cursor = endId;
  while (cursor !== startId) {
    const step = prev.get(cursor);
    if (!step) return { ok: true, result: { path: null, settled } };
    edges.push(step.edge);
    nodeIds.push(step.node);
    cursor = step.node;
  }
  nodeIds.reverse();
  edges.reverse();

  // 拼接高亮折线
  const polyline: { x: number; y: number }[] = [];
  for (const edge of edges) {
    const segment = polyline.length === 0 ? edge.polyline : edge.polyline.slice(1);
    polyline.push(...segment);
  }

  return {
    ok: true,
    result: {
      path: {
        nodeIds,
        roadIds: edges.map((e) => e.roadId),
        length: dist.get(endId)!,
        meters: pixelsToMeters(dist.get(endId)!, scale),
        polyline,
      },
      settled,
    },
  };
}

/** 把节点 id 序列转成可读字符串，例如 "A -> C -> E" */
export function formatNodeSequence(nodeIds: string[], nodes: MapNode[]): string {
  const nameById = new Map(nodes.map((n) => [n.id, n.name]));
  return nodeIds.map((id) => nameById.get(id) ?? id).join(' -> ');
}

/** 格式化长度：比例尺未校准，单位固定为“像素” */
export function formatPixelLength(length: number): string {
  return `${length.toFixed(1)} ${LENGTH_UNIT}`;
}

/** 端点直线距离（仅用于对比说明“折线长度 ≠ 直线距离”，不作为权重） */
export function endpointStraightDistance(from: MapNode, to: MapNode): number {
  return distance(from.point, to.point);
}
