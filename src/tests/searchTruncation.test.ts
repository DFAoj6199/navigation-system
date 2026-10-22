import { describe, it, expect, beforeEach } from 'vitest';
import { useAppStore } from '../store/useAppStore';
import type { MapNode, Road } from '../types';

/**
 * 回归测试：简单路径搜索被上限截断时，绝不能把「未完成」报成「无路径」。
 *
 * 背景（真实缺陷）：165 节点 / 248 道路的项目上，DFS 在找到第一条路径之前
 * 就耗尽 maxExpansions，simple.paths 为空但不代表不可达；而 Dijkstra 仍能
 * 给出真实最短路径。旧逻辑据此设置 status='no-path'，同时又高亮了最短路径，
 * 于是面板显示「当前无路径」而地图上高亮着一条真实的路，互相矛盾。
 */

function makeNodes(count: number): MapNode[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `n${i}`,
    name: `N${i}`,
    point: { x: i * 10, y: 0 },
    type: 'junction' as const,
    createdAt: `2024-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`,
  }));
}

/** 一条长链 n0 - n1 - ... - n{count-1}，任意两点的简单路径唯一 */
function makeChainRoads(count: number): Road[] {
  const roads: Road[] = [];
  for (let i = 0; i < count - 1; i += 1) {
    roads.push({
      id: `r${i}`,
      fromNodeId: `n${i}`,
      toNodeId: `n${i + 1}`,
      points: [],
      createdAt: `2024-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`,
    });
  }
  return roads;
}

function seed(nodes: MapNode[], roads: Road[], maxExpansions?: number) {
  useAppStore.setState({
    image: {
      fileName: 'x.png',
      width: 2000,
      height: 2000,
      mimeType: 'image/png',
    },
    imageUrl: 'blob:x',
    imageWidth: 2000,
    imageHeight: 2000,
    nodes,
    roads,
    scale: null,
    startNodeId: '',
    endNodeId: '',
    searchLimits: {
      maxResults: 200,
      maxExpansions: maxExpansions ?? 200_000,
    },
    notices: [],
  });
}

describe('搜索被截断时不得误报「当前无路径」', () => {
  beforeEach(() => {
    useAppStore.setState({ nodes: [], roads: [], startNodeId: '', endNodeId: '' });
  });

  it('扩展次数耗尽且零结果时，状态是 partial 而不是 no-path', () => {
    const nodes = makeNodes(12);
    const roads = makeChainRoads(12);
    // 把上限压到极小，强制在找到路径前就超限
    seed(nodes, roads, 3);

    useAppStore.getState().setStartNodeId('n0');
    useAppStore.getState().setEndNodeId('n11');
    const r = useAppStore.getState().runSearch();
    expect(r.ok).toBe(true);

    const s = useAppStore.getState().search;
    expect(s.simple?.complete).toBe(false);
    expect(s.simple?.truncated).toBe(true);
    expect(s.simple?.truncatedReason).toBe('maxExpansions');
    expect(s.status).toBe('partial');
    expect(s.status).not.toBe('no-path');
  });

  it('状态为 partial 时，最短路径依然可用且地图高亮与之一致', () => {
    const nodes = makeNodes(12);
    const roads = makeChainRoads(12);
    seed(nodes, roads, 3);

    useAppStore.getState().setStartNodeId('n0');
    useAppStore.getState().setEndNodeId('n11');
    useAppStore.getState().runSearch();

    const s = useAppStore.getState().search;
    expect(s.status).toBe('partial');
    // Dijkstra 是多项式复杂度，必然能给出结果
    expect(s.shortest).not.toBeNull();
    expect(s.shortest?.nodeIds).toEqual(nodes.map((n) => n.id));
    // 高亮必须与最短路径一致，不能出现「面板无路径但地图有高亮」的矛盾
    expect(s.highlightedRoadIds).toEqual(s.shortest!.roadIds);
    expect(s.highlightedRoadIds.length).toBe(11);
    expect(s.highlightedNodeIds).toEqual(s.shortest!.nodeIds);
  });

  it('搜索完整穷举且确实不可达时，状态才是 no-path', () => {
    const nodes = makeNodes(6);
    // 只连 n0-n1-n2，n3/n4/n5 是孤岛
    const roads = makeChainRoads(3);
    seed(nodes, roads);

    useAppStore.getState().setStartNodeId('n0');
    useAppStore.getState().setEndNodeId('n5');
    useAppStore.getState().runSearch();

    const s = useAppStore.getState().search;
    expect(s.simple?.complete).toBe(true);
    expect(s.simple?.truncated).toBe(false);
    expect(s.status).toBe('no-path');
    expect(s.shortest).toBeNull();
    expect(s.highlightedRoadIds).toEqual([]);
  });

  it('只有结果数达到 maxResults 而扩展未超限时，仍是 found', () => {
    const nodes = makeNodes(10);
    // 完全图：任意两点间有大量简单路径
    const roads: Road[] = [];
    let k = 0;
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        roads.push({
          id: `r${k++}`,
          fromNodeId: `n${i}`,
          toNodeId: `n${j}`,
          points: [],
          createdAt: `2024-01-01T00:00:${String(k % 60).padStart(2, '0')}Z`,
        });
      }
    }
    seed(nodes, roads);
    useAppStore.getState().setSearchLimits({ maxResults: 5 });

    useAppStore.getState().setStartNodeId('n0');
    useAppStore.getState().setEndNodeId('n9');
    useAppStore.getState().runSearch();

    const s = useAppStore.getState().search;
    expect(s.status).toBe('found');
    expect(s.simple?.paths.length).toBe(5);
    expect(s.simple?.complete).toBe(false);
    expect(s.simple?.truncatedReason).toBe('maxResults');
  });
});
