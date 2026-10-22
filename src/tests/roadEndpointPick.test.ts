import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../store/useAppStore';
import type { MapImageMeta } from '../types';

/**
 * 点击地图节点选择道路起点 / 终点。
 *
 * 验收要点：
 *   - 选起点后自动切到选终点；
 *   - 选完终点自动退出点选；
 *   - 起点与终点不能是同一个节点；
 *   - 未进入点选状态时点击节点不影响端点；
 *   - 开始绘制后清空临时选中结果，避免下次新建残留。
 */

const META: MapImageMeta = {
  fileName: 'tianhe.png',
  width: 1600,
  height: 1200,
  mimeType: 'image/png',
};

const S = () => useAppStore.getState();

function reset() {
  useAppStore.setState({
    image: META,
    imageUrl: null,
    imageWidth: 1600,
    imageHeight: 1200,
    nodes: [],
    roads: [],
    draft: null,
    roadEndpointPicking: null,
    pickedFromNodeId: '',
    pickedToNodeId: '',
  });
}

function addNode(x: number, y: number, name: string) {
  const r = S().addNodeAtPixel(x, y, name);
  if (!r.ok || !r.node) throw new Error(r.error ?? '添加节点失败');
  return r.node;
}

describe('点击地图节点选择道路端点', () => {
  beforeEach(() => {
    reset();
  });

  it('选起点后自动切换到选终点', () => {
    const a = addNode(100, 100, 'A');
    S().setRoadEndpointPicking('from');
    S().applyPickedRoadEndpoint(a.id);
    expect(S().pickedFromNodeId).toBe(a.id);
    expect(S().roadEndpointPicking).toBe('to');
  });

  it('选完终点后自动退出点选状态', () => {
    const a = addNode(100, 100, 'A');
    const b = addNode(500, 100, 'B');
    S().setRoadEndpointPicking('from');
    S().applyPickedRoadEndpoint(a.id);
    S().applyPickedRoadEndpoint(b.id);
    expect(S().pickedFromNodeId).toBe(a.id);
    expect(S().pickedToNodeId).toBe(b.id);
    expect(S().roadEndpointPicking).toBeNull();
  });

  it('起点与终点相同时忽略，仍停留在选终点', () => {
    const a = addNode(100, 100, 'A');
    S().setRoadEndpointPicking('from');
    S().applyPickedRoadEndpoint(a.id);
    S().applyPickedRoadEndpoint(a.id);
    expect(S().pickedToNodeId).toBe('');
    expect(S().roadEndpointPicking).toBe('to');
  });

  it('未进入点选状态时点击节点不改变端点', () => {
    const a = addNode(100, 100, 'A');
    const b = addNode(500, 100, 'B');
    S().applyPickedRoadEndpoint(a.id);
    S().applyPickedRoadEndpoint(b.id);
    expect(S().pickedFromNodeId).toBe('');
    expect(S().pickedToNodeId).toBe('');
  });

  it('点选不存在的节点 id 被忽略', () => {
    addNode(100, 100, 'A');
    S().setRoadEndpointPicking('from');
    S().applyPickedRoadEndpoint('ghost');
    expect(S().pickedFromNodeId).toBe('');
    expect(S().roadEndpointPicking).toBe('from');
  });

  it('开始绘制后清空临时选中结果，避免下次残留', () => {
    const a = addNode(100, 100, 'A');
    const b = addNode(500, 100, 'B');
    S().setRoadEndpointPicking('from');
    S().applyPickedRoadEndpoint(a.id);
    S().applyPickedRoadEndpoint(b.id);

    const r = S().startRoadDraft(a.id, b.id);
    expect(r.ok).toBe(true);
    expect(S().pickedFromNodeId).toBe('');
    expect(S().pickedToNodeId).toBe('');
    expect(S().roadEndpointPicking).toBeNull();
    expect(S().draft?.fromNodeId).toBe(a.id);
    expect(S().draft?.toNodeId).toBe(b.id);
  });
});
