import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../store/useAppStore';
import { findDanglingRoads } from '../lib/roads';
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
  });
}

/** 建好底图与两个节点，返回节点 id */
function setupTwoNodes() {
  useAppStore.getState().setImage(META, 'blob:test');
  const a = useAppStore.getState().addNodeAtPixel(100, 100, 'A').node!;
  const b = useAppStore.getState().addNodeAtPixel(600, 400, 'B').node!;
  return { a, b };
}

describe('useAppStore - 道路管理（阶段2）', () => {
  beforeEach(() => {
    resetStore();
    URL.createObjectURL = () => 'blob:test';
    URL.revokeObjectURL = () => {};
  });

  it('开始绘制后逐点添加中间点，完成后落库', () => {
    const { a, b } = setupTwoNodes();

    expect(useAppStore.getState().startRoadDraft(a.id, b.id).ok).toBe(true);
    expect(useAppStore.getState().draft?.points).toHaveLength(0);

    useAppStore.getState().addDraftPoint(200, 150);
    useAppStore.getState().addDraftPoint(300, 300);
    useAppStore.getState().addDraftPoint(400, 350);
    expect(useAppStore.getState().draft?.points).toHaveLength(3);

    const committed = useAppStore.getState().commitRoadDraft();
    expect(committed.ok).toBe(true);

    const roads = useAppStore.getState().roads;
    expect(roads).toHaveLength(1);
    expect(roads[0].fromNodeId).toBe(a.id);
    expect(roads[0].toNodeId).toBe(b.id);
    expect(roads[0].points).toEqual([
      { x: 200, y: 150 },
      { x: 300, y: 300 },
      { x: 400, y: 350 },
    ]);
    // 完成后退出绘制状态并选中新道路
    expect(useAppStore.getState().draft).toBeNull();
    expect(useAppStore.getState().selectedRoadId).toBe(roads[0].id);
  });

  it('支持任意数量中间点，不简化为直线', () => {
    const { a, b } = setupTwoNodes();
    useAppStore.getState().startRoadDraft(a.id, b.id);
    for (let i = 1; i <= 20; i += 1) {
      useAppStore.getState().addDraftPoint(100 + i * 20, 100 + (i % 5) * 30);
    }
    useAppStore.getState().commitRoadDraft();
    expect(useAppStore.getState().roads[0].points).toHaveLength(20);
  });

  it('0 个中间点也是合法道路（两端直连）', () => {
    const { a, b } = setupTwoNodes();
    useAppStore.getState().startRoadDraft(a.id, b.id);
    expect(useAppStore.getState().commitRoadDraft().ok).toBe(true);
    expect(useAppStore.getState().roads[0].points).toHaveLength(0);
  });

  it('端点相同无法开始绘制', () => {
    const { a } = setupTwoNodes();
    const r = useAppStore.getState().startRoadDraft(a.id, a.id);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('不能是同一个节点');
  });

  it('同一对节点不能重复建路（反向也不行）', () => {
    const { a, b } = setupTwoNodes();
    useAppStore.getState().startRoadDraft(a.id, b.id);
    useAppStore.getState().commitRoadDraft();

    const again = useAppStore.getState().startRoadDraft(b.id, a.id);
    expect(again.ok).toBe(false);
    expect(again.error).toContain('已存在道路');
  });

  it('撤销与清空中间点', () => {
    const { a, b } = setupTwoNodes();
    useAppStore.getState().startRoadDraft(a.id, b.id);
    useAppStore.getState().addDraftPoint(1, 1);
    useAppStore.getState().addDraftPoint(2, 2);
    useAppStore.getState().undoDraftPoint();
    expect(useAppStore.getState().draft?.points).toEqual([{ x: 1, y: 1 }]);
    useAppStore.getState().clearDraftPoints();
    expect(useAppStore.getState().draft?.points).toHaveLength(0);
  });

  it('取消绘制不产生道路', () => {
    const { a, b } = setupTwoNodes();
    useAppStore.getState().startRoadDraft(a.id, b.id);
    useAppStore.getState().addDraftPoint(50, 50);
    useAppStore.getState().cancelRoadDraft();
    expect(useAppStore.getState().draft).toBeNull();
    expect(useAppStore.getState().roads).toHaveLength(0);
  });

  it('中间点超出图片范围被拒绝', () => {
    const { a, b } = setupTwoNodes();
    useAppStore.getState().startRoadDraft(a.id, b.id);
    const r = useAppStore.getState().addDraftPoint(5000, 10);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('超出地图范围');
    expect(useAppStore.getState().draft?.points).toHaveLength(0);
  });

  it('重新绘制替换中间点但保留同一道路 id 与端点', () => {
    const { a, b } = setupTwoNodes();
    useAppStore.getState().startRoadDraft(a.id, b.id);
    useAppStore.getState().addDraftPoint(200, 200);
    const created = useAppStore.getState().commitRoadDraft();
    const roadId = created.roadId!;

    expect(useAppStore.getState().startRedrawRoad(roadId).ok).toBe(true);
    useAppStore.getState().addDraftPoint(350, 150);
    useAppStore.getState().addDraftPoint(450, 250);
    const replaced = useAppStore.getState().commitRoadDraft();

    expect(replaced.ok).toBe(true);
    expect(replaced.replaced).toBe(true);
    const roads = useAppStore.getState().roads;
    expect(roads).toHaveLength(1);
    expect(roads[0].id).toBe(roadId);
    expect(roads[0].fromNodeId).toBe(a.id);
    expect(roads[0].toNodeId).toBe(b.id);
    expect(roads[0].points).toEqual([{ x: 350, y: 150 }, { x: 450, y: 250 }]);
  });

  it('修改与删除道路', () => {
    const { a, b } = setupTwoNodes();
    useAppStore.getState().startRoadDraft(a.id, b.id);
    const { roadId } = useAppStore.getState().commitRoadDraft();

    expect(useAppStore.getState().renameRoad(roadId!, '天河路')).toEqual({ ok: true });
    expect(useAppStore.getState().roads[0].name).toBe('天河路');

    useAppStore.getState().deleteRoad(roadId!);
    expect(useAppStore.getState().roads).toHaveLength(0);
    expect(useAppStore.getState().selectedRoadId).toBeNull();
  });

  it('拖动修改已存道路的中间点', () => {
    const { a, b } = setupTwoNodes();
    useAppStore.getState().startRoadDraft(a.id, b.id);
    useAppStore.getState().addDraftPoint(200, 200);
    const { roadId } = useAppStore.getState().commitRoadDraft();

    const r = useAppStore.getState().updateRoadPoint(roadId!, 0, 321, 456);
    expect(r.ok).toBe(true);
    expect(useAppStore.getState().roads[0].points[0]).toEqual({ x: 321, y: 456 });

    const bad = useAppStore.getState().updateRoadPoint(roadId!, 0, 9999, 1);
    expect(bad.ok).toBe(false);
    expect(useAppStore.getState().roads[0].points[0]).toEqual({ x: 321, y: 456 });
  });

  it('删除节点时级联删除关联道路，不留悬空引用', () => {
    useAppStore.getState().setImage(META, 'blob:test');
    const a = useAppStore.getState().addNodeAtPixel(100, 100, 'A').node!;
    const b = useAppStore.getState().addNodeAtPixel(400, 100, 'B').node!;
    const c = useAppStore.getState().addNodeAtPixel(700, 400, 'C').node!;

    for (const [x, y] of [[a.id, b.id], [b.id, c.id]] as const) {
      useAppStore.getState().startRoadDraft(x, y);
      useAppStore.getState().commitRoadDraft();
    }
    expect(useAppStore.getState().roads).toHaveLength(2);

    // 删除中间节点 B：两条关联道路都应被删除
    const result = useAppStore.getState().deleteNode(b.id);
    expect(result.ok).toBe(true);
    expect(result.removedRoads).toBe(2);
    expect(useAppStore.getState().roads).toHaveLength(0);

    // 严格校验：不存在指向已删除节点的道路
    expect(findDanglingRoads(useAppStore.getState().roads, useAppStore.getState().nodes)).toEqual([]);
  });

  it('删除节点时只删除与其关联的道路', () => {
    useAppStore.getState().setImage(META, 'blob:test');
    const a = useAppStore.getState().addNodeAtPixel(100, 100, 'A').node!;
    const b = useAppStore.getState().addNodeAtPixel(400, 100, 'B').node!;
    const c = useAppStore.getState().addNodeAtPixel(700, 400, 'C').node!;
    const d = useAppStore.getState().addNodeAtPixel(200, 600, 'D').node!;

    for (const [x, y] of [[a.id, b.id], [c.id, d.id]] as const) {
      useAppStore.getState().startRoadDraft(x, y);
      useAppStore.getState().commitRoadDraft();
    }

    useAppStore.getState().deleteNode(a.id);
    const roads = useAppStore.getState().roads;
    expect(roads).toHaveLength(1);
    expect(roads[0].fromNodeId).toBe(c.id);
    expect(roads[0].toNodeId).toBe(d.id);
  });

  it('删除节点会作废引用它的绘制草稿', () => {
    const { a, b } = setupTwoNodes();
    useAppStore.getState().startRoadDraft(a.id, b.id);
    useAppStore.getState().deleteNode(b.id);
    expect(useAppStore.getState().draft).toBeNull();
  });

  it('换底图会清空节点与道路', () => {
    const { a, b } = setupTwoNodes();
    useAppStore.getState().startRoadDraft(a.id, b.id);
    useAppStore.getState().commitRoadDraft();

    useAppStore.getState().setImage({ ...META, width: 2000 }, 'blob:test2');
    expect(useAppStore.getState().nodes).toHaveLength(0);
    expect(useAppStore.getState().roads).toHaveLength(0);
  });

  it('toProject 输出包含 roads', () => {
    const { a, b } = setupTwoNodes();
    useAppStore.getState().startRoadDraft(a.id, b.id);
    useAppStore.getState().commitRoadDraft();
    const project = useAppStore.getState().toProject();
    expect(project?.roads).toHaveLength(1);
    expect(project?.nodes).toHaveLength(2);
  });
});
