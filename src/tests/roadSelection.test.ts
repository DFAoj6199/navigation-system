import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../store/useAppStore';
import type { MapImageMeta } from '../types';

/**
 * 道路选中态切换：再次点击已选中的道路必须取消选中，
 * 并让地图高亮恢复为未选中状态。
 */

const META: MapImageMeta = {
  fileName: 'tianhe.png',
  width: 1600,
  height: 1200,
  mimeType: 'image/png',
};

function addNode(x: number, y: number, name: string) {
  const r = useAppStore.getState().addNodeAtPixel(x, y, name);
  if (!r.ok || !r.node) throw new Error(r.error ?? '添加节点失败');
  return r.node.id;
}

function buildRoad(fromId: string, toId: string) {
  const started = useAppStore.getState().startRoadDraft(fromId, toId);
  if (!started.ok) throw new Error(started.error ?? '开始绘制失败');
  const done = useAppStore.getState().commitRoadDraft();
  if (!done.ok) throw new Error(done.error ?? '完成绘制失败');
  return done.roadId!;
}

describe('道路选中状态切换', () => {
  let roadA: string;
  let roadB: string;

  beforeEach(() => {
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
    URL.createObjectURL = () => 'blob:test';
    URL.revokeObjectURL = () => {};
    useAppStore.getState().setImage(META, 'blob:test');

    const A = addNode(0, 0, 'A');
    const B = addNode(300, 0, 'B');
    const C = addNode(600, 0, 'C');
    roadA = buildRoad(A, B);
    roadB = buildRoad(B, C);
  });

  it('首次点击选中道路', () => {
    useAppStore.getState().toggleRoadSelection(roadA);
    expect(useAppStore.getState().selectedRoadId).toBe(roadA);
  });

  it('再次点击同一条道路取消选中', () => {
    useAppStore.getState().toggleRoadSelection(roadA);
    expect(useAppStore.getState().selectedRoadId).toBe(roadA);

    useAppStore.getState().toggleRoadSelection(roadA);
    expect(useAppStore.getState().selectedRoadId).toBeNull();
  });

  it('取消选中后第三次点击可重新选中（可反复切换）', () => {
    const g = () => useAppStore.getState();
    g().toggleRoadSelection(roadA);
    g().toggleRoadSelection(roadA);
    expect(g().selectedRoadId).toBeNull();
    g().toggleRoadSelection(roadA);
    expect(g().selectedRoadId).toBe(roadA);
  });

  it('点击另一条道路切换到该道路，而不是取消', () => {
    const g = () => useAppStore.getState();
    g().toggleRoadSelection(roadA);
    g().toggleRoadSelection(roadB);
    expect(g().selectedRoadId).toBe(roadB);
    // 再点一次 B 才取消
    g().toggleRoadSelection(roadB);
    expect(g().selectedRoadId).toBeNull();
  });

  it('切换选中状态不影响道路与节点数据', () => {
    const before = {
      roads: JSON.stringify(useAppStore.getState().roads),
      nodes: JSON.stringify(useAppStore.getState().nodes),
    };
    const g = () => useAppStore.getState();
    g().toggleRoadSelection(roadA);
    g().toggleRoadSelection(roadA);
    g().toggleRoadSelection(roadB);
    g().toggleRoadSelection(roadB);
    expect(JSON.stringify(g().roads)).toBe(before.roads);
    expect(JSON.stringify(g().nodes)).toBe(before.nodes);
  });

  it('取消选中时同步清除节点选中，避免残留高亮', () => {
    const g = () => useAppStore.getState();
    const someNode = g().nodes[0].id;
    g().selectNode(someNode);
    g().toggleRoadSelection(roadA);
    expect(g().selectedNodeId).toBeNull();
    g().toggleRoadSelection(roadA);
    expect(g().selectedRoadId).toBeNull();
    expect(g().selectedNodeId).toBeNull();
  });

  it('selectRoad 仍保持“直接选中”语义（拖拽中间点依赖它）', () => {
    const g = () => useAppStore.getState();
    g().toggleRoadSelection(roadA);
    // 对已选中的道路再次 selectRoad 不应取消
    g().selectRoad(roadA);
    expect(g().selectedRoadId).toBe(roadA);
  });
});
