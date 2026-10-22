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
    camera: { zoom: 1, offsetX: 0, offsetY: 0 },
    viewInitialized: false,
    notices: [],
  });
}

describe('useAppStore - 节点管理', () => {
  beforeEach(() => {
    resetStore();
    // jsdom 没有 createObjectURL / revokeObjectURL 的真实实现，测试中打桩
    URL.createObjectURL = () => 'blob:test';
    URL.revokeObjectURL = () => {};
  });

  it('未上传底图时不能添加节点', () => {
    const result = useAppStore.getState().addNodeAtPixel(10, 10);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('请先上传地图图片');
  });

  it('上传底图后可添加节点，坐标被取整并自动命名', () => {
    const store = useAppStore.getState();
    store.setImage(META, 'blob:test');

    const result = useAppStore.getState().addNodeAtPixel(120.4, 240.6);
    expect(result.ok).toBe(true);
    expect(result.node?.point).toEqual({ x: 120, y: 241 });
    expect(result.node?.name).toBe('节点 1');

    const nodes = useAppStore.getState().nodes;
    expect(nodes).toHaveLength(1);
    // 新节点自动选中
    expect(useAppStore.getState().selectedNodeId).toBe(nodes[0].id);
  });

  it('超出图片范围的坐标被拒绝，且不产生节点', () => {
    useAppStore.getState().setImage(META, 'blob:test');
    const outOfRange = useAppStore.getState().addNodeAtPixel(1500, 100);
    expect(outOfRange.ok).toBe(false);
    expect(outOfRange.error).toContain('超出图片范围');
    expect(useAppStore.getState().nodes).toHaveLength(0);
  });

  it('改名成功，重名与空名被拒绝', () => {
    useAppStore.getState().setImage(META, 'blob:test');
    const a = useAppStore.getState().addNodeAtPixel(10, 10, 'A').node!;
    const b = useAppStore.getState().addNodeAtPixel(20, 20, 'B').node!;

    expect(useAppStore.getState().renameNode(a.id, 'A2')).toEqual({ ok: true });
    expect(useAppStore.getState().nodes.find((n) => n.id === a.id)?.name).toBe('A2');

    const dup = useAppStore.getState().renameNode(a.id, 'B');
    expect(dup.ok).toBe(false);
    expect(dup.error).toContain('同名');

    const empty = useAppStore.getState().renameNode(b.id, '   ');
    expect(empty.ok).toBe(false);
  });

  it('修改节点坐标：合法则更新，越界则拒绝并保持原值', () => {
    useAppStore.getState().setImage(META, 'blob:test');
    const node = useAppStore.getState().addNodeAtPixel(10, 10).node!;

    expect(useAppStore.getState().moveNode(node.id, 999, 799)).toEqual({ ok: true });
    expect(useAppStore.getState().nodes[0].point).toEqual({ x: 999, y: 799 });

    const bad = useAppStore.getState().moveNode(node.id, 999, 900);
    expect(bad.ok).toBe(false);
    expect(useAppStore.getState().nodes[0].point).toEqual({ x: 999, y: 799 });
  });

  it('删除节点同时清理选中状态', () => {
    useAppStore.getState().setImage(META, 'blob:test');
    const node = useAppStore.getState().addNodeAtPixel(10, 10).node!;
    expect(useAppStore.getState().selectedNodeId).toBe(node.id);

    useAppStore.getState().deleteNode(node.id);
    expect(useAppStore.getState().nodes).toHaveLength(0);
    expect(useAppStore.getState().selectedNodeId).toBeNull();
  });

  it('缩放/平移只改相机，不改节点像素坐标', () => {
    useAppStore.getState().setImage(META, 'blob:test');
    const node = useAppStore.getState().addNodeAtPixel(300, 400).node!;
    const before = { ...node.point };

    useAppStore.getState().setCamera({ zoom: 3.25, offsetX: -120, offsetY: -55 });
    useAppStore.getState().setNodeType(node.id, 'landmark');

    const after = useAppStore.getState().nodes.find((n) => n.id === node.id)!;
    expect(after.point).toEqual(before);
    expect(after.type).toBe('landmark');
  });

  it('重新上传底图会清空节点，避免旧坐标错位', () => {
    useAppStore.getState().setImage(META, 'blob:test');
    useAppStore.getState().addNodeAtPixel(10, 10);
    expect(useAppStore.getState().nodes).toHaveLength(1);

    useAppStore.getState().setImage({ ...META, width: 2000, height: 1600 }, 'blob:test2');
    expect(useAppStore.getState().nodes).toHaveLength(0);
    expect(useAppStore.getState().imageWidth).toBe(2000);
  });

  it('toProject 只输出预留结构，roads 为空数组', () => {
    useAppStore.getState().setImage(META, 'blob:test');
    useAppStore.getState().addNodeAtPixel(1, 2);
    const project = useAppStore.getState().toProject();
    expect(project?.version).toBe(1);
    expect(project?.roads).toEqual([]);
    expect(project?.nodes).toHaveLength(1);
  });
});
