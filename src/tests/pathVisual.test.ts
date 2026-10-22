import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../store/useAppStore';
import { createMapScale } from '../lib/scale';
import { nodeFillColor, PATH_ROLE_COLORS } from '../lib/constants';
import type { MapImageMeta } from '../types';

/**
 * 阶段5 验收：路线可视化与搜索结果展示。
 *
 * 重点保证：
 *   1. 切换高亮路线绝不修改道路、节点或距离数据；
 *   2. 高亮折线复用道路真实折线坐标（含中间点），不是端点连线；
 *   3. 起终点、路线节点与普通节点配色不同；
 *   4. 无路径时清除旧高亮。
 */

const META: MapImageMeta = {
  fileName: 'tianhe.png',
  width: 1600,
  height: 1200,
  mimeType: 'image/png',
};

function resetStore() {
  useAppStore.setState({
    image: null,
    imageUrl: null,
    imageWidth: 0,
    imageHeight: 0,
    nodes: [],
    roads: [],
    selectedNodeId: null,
    selectedRoadId: null,
    camera: { zoom: 1, offsetX: 0, offsetY: 0 },
    viewInitialized: false,
    draft: null,
    notices: [],
    startNodeId: '',
    endNodeId: '',
    scale: null,
    scalePointA: null,
    scalePointB: null,
    scalePicking: false,
    scaleNextPoint: 'a',
  });
}

function addNode(x: number, y: number, name: string) {
  const r = useAppStore.getState().addNodeAtPixel(x, y, name);
  if (!r.ok || !r.node) throw new Error(r.error ?? '添加节点失败');
  return r.node.id;
}

function buildRoad(fromId: string, toId: string, mids: { x: number; y: number }[] = []) {
  const started = useAppStore.getState().startRoadDraft(fromId, toId);
  if (!started.ok) throw new Error(started.error ?? '开始绘制失败');
  for (const m of mids) {
    const r = useAppStore.getState().addDraftPoint(m.x, m.y);
    if (!r.ok) throw new Error(r.error ?? '添加中间点失败');
  }
  const done = useAppStore.getState().commitRoadDraft();
  if (!done.ok) throw new Error(done.error ?? '完成绘制失败');
  return done.roadId!;
}

/** 建一个 A->B 有两条路线的图：A-B 直连（带中间点）与 A->C->B */
function buildTwoRouteGraph() {
  resetStore();
  URL.createObjectURL = () => 'blob:test';
  URL.revokeObjectURL = () => {};
  useAppStore.getState().setImage(META, 'blob:test');

  const A = addNode(0, 0, 'A');
  const B = addNode(600, 0, 'B');
  const C = addNode(300, 400, 'C');
  // A->B 直连但绕行：带两个中间点，(0,0)->(0,300)->(600,300)->(600,0) = 300+600+300 = 1200
  const directRoad = buildRoad(A, B, [
    { x: 0, y: 300 },
    { x: 600, y: 300 },
  ]);
  // A->C->B = 500 + 500 = 1000（更短）
  const acRoad = buildRoad(A, C);
  const cbRoad = buildRoad(C, B);

  useAppStore.getState().setStartNodeId(A);
  useAppStore.getState().setEndNodeId(B);
  useAppStore.getState().runSearch();

  return { A, B, C, directRoad, acRoad, cbRoad };
}

describe('阶段5 - 路线可视化与搜索结果', () => {
  beforeEach(() => {
    resetStore();
  });

  it('搜索后默认高亮最短路径，并标注搜索的起点与终点', () => {
    const { A, B } = buildTwoRouteGraph();
    const search = useAppStore.getState().search;

    expect(search.status).toBe('found');
    expect(search.searchedStartId).toBe(A);
    expect(search.searchedEndId).toBe(B);
    // 最短为 A->C->B（1000 < 1200），C 在中间
    expect(search.shortest!.nodeIds).toHaveLength(3);
    expect(search.shortest!.nodeIds[0]).toBe(A);
    expect(search.shortest!.nodeIds[2]).toBe(B);
    expect(search.shortest!.length).toBeCloseTo(1000, 6);
  });

  it('默认高亮最短路径经过的节点与道路', () => {
    const { A, B, C, acRoad, cbRoad, directRoad } = buildTwoRouteGraph();
    const search = useAppStore.getState().search;

    expect(search.highlightedNodeIds).toEqual([A, C, B]);
    expect(search.highlightedRoadIds).toEqual([acRoad, cbRoad]);
    // 绕行的直连道路更长（1200），不应被默认高亮
    expect(search.highlightedRoadIds).not.toContain(directRoad);
  });

  it('高亮折线复用道路真实折线（含中间点），不是端点直线', () => {
    const { A, B } = buildTwoRouteGraph();
    // 选中那条带中间点的绕行道路（A->B 直连）
    const search = useAppStore.getState().search;
    const directPath = search.simple!.paths.find(
      (p) => p.roadIds.length === 1 && p.nodeIds.join() === [A, B].join(),
    );
    expect(directPath).toBeDefined();

    useAppStore.getState().highlightPath(directPath!);
    const polyline = useAppStore.getState().search.highlightedPolyline;

    // 必须包含中间点：(0,0) -> (0,300) -> (600,300) -> (600,0)，共 4 点
    expect(polyline).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 300 },
      { x: 600, y: 300 },
      { x: 600, y: 0 },
    ]);
    // 折线长度 1200，而不是端点直线 600
    expect(directPath!.length).toBeCloseTo(1200, 6);
  });

  it('切换高亮路线不修改节点、道路与距离数据', () => {
    buildTwoRouteGraph();
    const before = {
      nodes: JSON.stringify(useAppStore.getState().nodes),
      roads: JSON.stringify(useAppStore.getState().roads),
    };
    const search0 = useAppStore.getState().search;
    const distances = search0.simple!.paths.map((p) => p.length);
    const shortestLength = search0.shortest!.length;

    // 逐条切换高亮
    for (const path of search0.simple!.paths) {
      useAppStore.getState().highlightPath(path);
      expect(useAppStore.getState().search.highlightedNodeIds).toEqual(path.nodeIds);
      expect(useAppStore.getState().search.highlightedRoadIds).toEqual(path.roadIds);
    }

    const after = {
      nodes: JSON.stringify(useAppStore.getState().nodes),
      roads: JSON.stringify(useAppStore.getState().roads),
    };
    expect(after.nodes).toBe(before.nodes);
    expect(after.roads).toBe(before.roads);
    // 距离数据也不变
    expect(useAppStore.getState().search.simple!.paths.map((p) => p.length)).toEqual(distances);
    expect(useAppStore.getState().search.shortest!.length).toBeCloseTo(shortestLength, 9);
  });

  it('切换高亮不改变已校准的实际距离', () => {
    buildTwoRouteGraph();
    const cal = createMapScale({ x: 0, y: 0 }, { x: 500, y: 0 }, 500, 'm', 1600, 1200);
    if (!cal.ok) throw new Error('校准应成功');
    useAppStore.setState({ scale: cal.scale });
    useAppStore.getState().runSearch();

    const first = useAppStore.getState().search.simple!.paths[0];
    const metersBefore = first.meters;
    const scaleBefore = useAppStore.getState().scale!.metersPerPixel;

    useAppStore.getState().highlightPath(first);
    useAppStore.getState().highlightPath(useAppStore.getState().search.simple!.paths[1]);

    expect(useAppStore.getState().search.simple!.paths[0].meters).toBe(metersBefore);
    expect(useAppStore.getState().scale!.metersPerPixel).toBe(scaleBefore);
  });

  it('清除高亮后节点回到普通配色，数据仍不变', () => {
    buildTwoRouteGraph();
    const roadsBefore = JSON.stringify(useAppStore.getState().roads);
    useAppStore.getState().highlightPath(null);
    const search = useAppStore.getState().search;
    expect(search.highlightedNodeIds).toEqual([]);
    expect(search.highlightedRoadIds).toEqual([]);
    expect(search.highlightedPolyline).toEqual([]);
    expect(JSON.stringify(useAppStore.getState().roads)).toBe(roadsBefore);
  });

  it('无路径时显示 no-path 且清除旧高亮', () => {
    resetStore();
    URL.createObjectURL = () => 'blob:test';
    URL.revokeObjectURL = () => {};
    useAppStore.getState().setImage(META, 'blob:test');
    const A = addNode(0, 0, 'A');
    const B = addNode(100, 0, 'B');
    const D = addNode(900, 900, 'D');
    buildRoad(A, B);

    // 先做一次有结果的搜索，制造“旧高亮”
    useAppStore.getState().setStartNodeId(A);
    useAppStore.getState().setEndNodeId(B);
    useAppStore.getState().runSearch();
    expect(useAppStore.getState().search.highlightedRoadIds.length).toBeGreaterThan(0);

    // 改成不可达的终点
    useAppStore.getState().setEndNodeId(D);
    expect(useAppStore.getState().search.status).toBe('idle'); // 修改端点即失效
    useAppStore.getState().runSearch();
    const search = useAppStore.getState().search;

    expect(search.status).toBe('no-path');
    expect(search.highlightedRoadIds).toEqual([]);
    expect(search.highlightedNodeIds).toEqual([]);
    expect(search.highlightedPolyline).toEqual([]);
    expect(search.shortest).toBeNull();
  });

  it('所有路线结果都是“节点1 -> 节点2”形式', async () => {
    const { A, B, C } = buildTwoRouteGraph();
    const nodes = useAppStore.getState().nodes;
    const { formatNodeSequence } = await import('../lib/pathfinding');
    const paths = useAppStore.getState().search.simple!.paths;
    expect(paths.length).toBeGreaterThanOrEqual(2);
    const seqs = paths.map((p) => formatNodeSequence(p.nodeIds, nodes));
    expect(seqs).toContain('A -> C -> B');
    expect(seqs.some((x) => x.includes(' -> '))).toBe(true);
    // 序列必须首尾为起终点
    for (const p of paths) {
      expect(p.nodeIds[0]).toBe(A);
      expect(p.nodeIds[p.nodeIds.length - 1]).toBe(B);
      if (p.nodeIds.includes(C)) expect(p.nodeIds.length).toBe(3);
    }
  });
});

describe('阶段5 - 节点角色配色', () => {
  it('起点、终点、路线节点与普通节点颜色互不相同', () => {
    const normal = nodeFillColor('junction', 'normal');
    const start = nodeFillColor('junction', 'start');
    const end = nodeFillColor('junction', 'end');
    const onRoute = nodeFillColor('junction', 'onRoute');

    const colors = [normal, start, end, onRoute];
    expect(new Set(colors).size).toBe(4);
  });

  it('角色色优先于节点类型色', () => {
    // 同一角色下，不同类型节点显示同一角色色
    expect(nodeFillColor('junction', 'start')).toBe(PATH_ROLE_COLORS.start);
    expect(nodeFillColor('landmark', 'start')).toBe(PATH_ROLE_COLORS.start);
    expect(nodeFillColor('entrance', 'end')).toBe(PATH_ROLE_COLORS.end);
  });

  it('普通节点仍按类型着色', () => {
    expect(nodeFillColor('junction', 'normal')).toBe('#ef4444');
    expect(nodeFillColor('entrance', 'normal')).toBe('#2563eb');
    expect(nodeFillColor('landmark', 'normal')).toBe('#16a34a');
  });
});
