import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../store/useAppStore';
import type { MapImageMeta } from '../types';

const META: MapImageMeta = {
  fileName: 'tianhe.png',
  width: 1000,
  height: 800,
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
    searchLimits: { maxResults: 200, maxExpansions: 200_000 },
  });
}

/** 建图：A(0,0) - B(100,0) - C(200,0)，返回三个节点 */
function setupChain() {
  useAppStore.getState().setImage(META, 'blob:test');
  const a = useAppStore.getState().addNodeAtPixel(0, 0, 'A').node!;
  const b = useAppStore.getState().addNodeAtPixel(100, 0, 'B').node!;
  const c = useAppStore.getState().addNodeAtPixel(200, 0, 'C').node!;
  for (const [x, y] of [[a.id, b.id], [b.id, c.id]] as const) {
    useAppStore.getState().startRoadDraft(x, y);
    useAppStore.getState().commitRoadDraft();
  }
  return { a, b, c };
}

describe('useAppStore - 寻路（阶段3）', () => {
  beforeEach(() => {
    resetStore();
    URL.createObjectURL = () => 'blob:test';
    URL.revokeObjectURL = () => {};
  });

  it('未选起终点时返回明确错误', () => {
    setupChain();
    const r = useAppStore.getState().runSearch();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('请选择');
    expect(useAppStore.getState().search.status).toBe('error');
  });

  it('有路径时同时给出简单路径与最短路径', () => {
    const { a, b, c } = setupChain();
    useAppStore.getState().setStartNodeId(a.id);
    useAppStore.getState().setEndNodeId(c.id);
    const r = useAppStore.getState().runSearch();
    expect(r.ok).toBe(true);

    const search = useAppStore.getState().search;
    expect(search.status).toBe('found');
    // 唯一简单路径 A -> B -> C，长度 100 + 100 = 200（人工推导）
    expect(search.simple?.paths).toHaveLength(1);
    expect(search.simple?.paths[0].nodeIds).toEqual([a.id, b.id, c.id]);
    expect(search.simple?.paths[0].length).toBeCloseTo(200, 6);
    expect(search.shortest?.nodeIds).toEqual([a.id, b.id, c.id]);
    expect(search.shortest?.length).toBeCloseTo(200, 6);
    // 默认高亮最短路径
    expect(search.highlightedRoadIds).toHaveLength(2);
  });

  it('不连通时状态为 no-path', () => {
    useAppStore.getState().setImage(META, 'blob:test');
    const a = useAppStore.getState().addNodeAtPixel(0, 0, 'A').node!;
    const d = useAppStore.getState().addNodeAtPixel(900, 700, 'D').node!;
    const b = useAppStore.getState().addNodeAtPixel(100, 0, 'B').node!;
    const c = useAppStore.getState().addNodeAtPixel(800, 700, 'C').node!;
    for (const [x, y] of [[a.id, b.id], [c.id, d.id]] as const) {
      useAppStore.getState().startRoadDraft(x, y);
      useAppStore.getState().commitRoadDraft();
    }
    useAppStore.getState().setStartNodeId(a.id);
    useAppStore.getState().setEndNodeId(d.id);
    useAppStore.getState().runSearch();
    const search = useAppStore.getState().search;
    expect(search.status).toBe('no-path');
    expect(search.simple?.paths).toHaveLength(0);
    expect(search.simple?.complete).toBe(true);
    expect(search.shortest).toBeNull();
  });

  it('起终点相同时稳定返回单节点零长度路径', () => {
    const { a } = setupChain();
    useAppStore.getState().setStartNodeId(a.id);
    useAppStore.getState().setEndNodeId(a.id);
    useAppStore.getState().runSearch();
    const search = useAppStore.getState().search;
    expect(search.sameEndpoint).toBe(true);
    expect(search.status).toBe('found');
    expect(search.simple?.paths).toHaveLength(1);
    expect(search.simple?.paths[0].length).toBe(0);
  });

  it('搜索不会修改任何道路或节点', () => {
    const { a, c } = setupChain();
    const nodesBefore = JSON.stringify(useAppStore.getState().nodes);
    const roadsBefore = JSON.stringify(useAppStore.getState().roads);

    useAppStore.getState().setStartNodeId(a.id);
    useAppStore.getState().setEndNodeId(c.id);
    useAppStore.getState().runSearch();

    expect(JSON.stringify(useAppStore.getState().nodes)).toBe(nodesBefore);
    expect(JSON.stringify(useAppStore.getState().roads)).toBe(roadsBefore);
  });

  it('数量上限被遵守且完整性问题被标记', () => {
    // K5：5 个节点两两相连
    useAppStore.getState().setImage(META, 'blob:test');
    const ids = ['A', 'B', 'C', 'D', 'E'].map(
      (name, i) => useAppStore.getState().addNodeAtPixel(i * 50, (i % 2) * 30, name).node!.id,
    );
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        useAppStore.getState().startRoadDraft(ids[i], ids[j]);
        useAppStore.getState().commitRoadDraft();
      }
    }
    useAppStore.getState().setStartNodeId(ids[0]);
    useAppStore.getState().setEndNodeId(ids[1]);
    useAppStore.getState().setSearchLimits({ maxResults: 3 });
    useAppStore.getState().runSearch();

    const search = useAppStore.getState().search;
    expect(search.simple?.paths).toHaveLength(3);
    expect(search.simple?.truncated).toBe(true);
    expect(search.simple?.complete).toBe(false);
  });

  it('修改道路后旧结果失效（不会被当成新结果展示）', () => {
    const { a, c } = setupChain();
    useAppStore.getState().setStartNodeId(a.id);
    useAppStore.getState().setEndNodeId(c.id);
    useAppStore.getState().runSearch();
    expect(useAppStore.getState().search.status).toBe('found');

    const roadId = useAppStore.getState().roads[0].id;
    useAppStore.getState().deleteRoad(roadId);
    expect(useAppStore.getState().search.status).toBe('idle');
    expect(useAppStore.getState().search.simple).toBeNull();
  });

  it('删除起点节点会清空起点选择并失效结果', () => {
    const { a, c } = setupChain();
    useAppStore.getState().setStartNodeId(a.id);
    useAppStore.getState().setEndNodeId(c.id);
    useAppStore.getState().runSearch();

    useAppStore.getState().deleteNode(a.id);
    expect(useAppStore.getState().startNodeId).toBe('');
    expect(useAppStore.getState().search.status).toBe('idle');
  });
});
