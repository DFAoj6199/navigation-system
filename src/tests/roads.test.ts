import { describe, expect, it } from 'vitest';
import {
  buildRoadPolyline,
  composeRoadName,
  createRoad,
  distance,
  findDanglingRoads,
  isSameNodePair,
  polylineLength,
  polylineToSvgPoints,
  roadDisplayName,
  roadPairKey,
  roadsAffectedByNodeDeletion,
  validateNewRoad,
} from '../lib/roads';
import type { MapNode, Road } from '../types';

function node(id: string, name: string, x: number, y: number): MapNode {
  return { id, name, point: { x, y }, type: 'junction', createdAt: '2024-01-01T00:00:00.000Z' };
}

const A = node('a', 'A', 100, 100);
const B = node('b', 'B', 500, 100);
const C = node('c', 'C', 900, 400);

describe('createRoad', () => {
  it('生成唯一 ID 并保存有序中间点（取整）', () => {
    const r1 = createRoad('a', 'b', [{ x: 200.4, y: 150.6 }, { x: 300, y: 300 }]);
    const r2 = createRoad('a', 'b', []);
    expect(r1.id).not.toBe(r2.id);
    expect(r1.points).toEqual([{ x: 200, y: 151 }, { x: 300, y: 300 }]);
    expect(r1.fromNodeId).toBe('a');
    expect(r1.toNodeId).toBe('b');
  });

  it('中间点数量不固定：0 个、1 个、多个都要支持且不被简化', () => {
    expect(createRoad('a', 'b', []).points).toHaveLength(0);
    expect(createRoad('a', 'b', [{ x: 1, y: 1 }]).points).toHaveLength(1);
    const many = Array.from({ length: 12 }, (_, i) => ({ x: i * 10, y: i * 5 }));
    expect(createRoad('a', 'b', many).points).toHaveLength(12);
  });
});

describe('双向道路判定', () => {
  const road: Road = { id: 'r1', fromNodeId: 'a', toNodeId: 'b', points: [], createdAt: 'x' };

  it('无序键与方向无关', () => {
    expect(roadPairKey('b', 'a')).toBe(roadPairKey('a', 'b'));
  });

  it('同一对节点反向也算同一对', () => {
    expect(isSameNodePair(road, 'a', 'b')).toBe(true);
    expect(isSameNodePair(road, 'b', 'a')).toBe(true);
    expect(isSameNodePair(road, 'a', 'c')).toBe(false);
  });
});

describe('buildRoadPolyline 端点与节点保持一致', () => {
  it('折线首尾必须是两个节点的实时坐标', () => {
    const road: Road = {
      id: 'r',
      fromNodeId: 'a',
      toNodeId: 'b',
      points: [{ x: 250, y: 50 }, { x: 400, y: 120 }],
      createdAt: 'x',
    };
    const polyline = buildRoadPolyline(road, A.point, B.point);
    expect(polyline[0]).toEqual({ x: 100, y: 100 });
    expect(polyline[polyline.length - 1]).toEqual({ x: 500, y: 100 });
    expect(polyline).toHaveLength(4); // 2 端点 + 2 中间点
  });

  it('节点移动后折线端点自动跟随（道路本身不存端点坐标）', () => {
    const road: Road = { id: 'r', fromNodeId: 'a', toNodeId: 'b', points: [], createdAt: 'x' };
    const movedA = { x: 0, y: 0 };
    const polyline = buildRoadPolyline(road, movedA, B.point);
    expect(polyline[0]).toEqual({ x: 0, y: 0 });
    expect(road.points).toHaveLength(0); // 道路数据未变
  });

  it('0 个中间点时折线就是两点直连', () => {
    const road: Road = { id: 'r', fromNodeId: 'a', toNodeId: 'b', points: [], createdAt: 'x' };
    const polyline = buildRoadPolyline(road, A.point, B.point);
    expect(polyline).toEqual([{ x: 100, y: 100 }, { x: 500, y: 100 }]);
  });
});

describe('polylineToSvgPoints / polylineLength / distance', () => {
  it('序列化为 SVG points 字符串', () => {
    expect(polylineToSvgPoints([{ x: 1, y: 2 }, { x: 3, y: 4 }])).toBe('1,2 3,4');
  });

  it('按折线段累加长度（不是端点直线距离）', () => {
    const straight = [{ x: 0, y: 0 }, { x: 0, y: 100 }];
    const bent = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
    expect(polylineLength(straight)).toBe(100);
    // 折线长度 200，而两端直线距离约 141.4，必须能区分
    expect(polylineLength(bent)).toBe(200);
    expect(distance(bent[0], bent[2])).toBeCloseTo(141.42, 1);
    expect(polylineLength(bent)).not.toBeCloseTo(distance(bent[0], bent[2]), 1);
  });
});

describe('validateNewRoad', () => {
  const nodes = [A, B, C];

  it('端点缺失被拒绝', () => {
    const r = validateNewRoad(null, 'b', [], nodes, [], 1000, 1000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('请选择');
  });

  it('端点相同被拒绝', () => {
    const r = validateNewRoad('a', 'a', [], nodes, [], 1000, 1000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('不能是同一个节点');
  });

  it('端点节点不存在被拒绝', () => {
    const r = validateNewRoad('a', 'zzz', [], nodes, [], 1000, 1000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('不存在');
  });

  it('重复连接同一对节点被拒绝（反向也算重复）', () => {
    const existing: Road[] = [{ id: 'r', fromNodeId: 'b', toNodeId: 'a', points: [], createdAt: 'x' }];
    const r = validateNewRoad('a', 'b', [], nodes, existing, 1000, 1000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('已存在道路');
  });

  it('中间点超出地图范围被拒绝并指明序号', () => {
    const r = validateNewRoad('a', 'b', [{ x: 10, y: 10 }, { x: 2000, y: 10 }], nodes, [], 1000, 1000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('第 2 个中间点');
  });

  it('合法输入通过（0 个或任意多个中间点）', () => {
    expect(validateNewRoad('a', 'b', [], nodes, [], 1000, 1000).ok).toBe(true);
    expect(validateNewRoad('a', 'b', [{ x: 1, y: 1 }, { x: 2, y: 2 }], nodes, [], 1000, 1000).ok).toBe(true);
  });
});

describe('删除节点时关联道路的处理', () => {
  const roads: Road[] = [
    { id: 'r1', fromNodeId: 'a', toNodeId: 'b', points: [], createdAt: 'x' },
    { id: 'r2', fromNodeId: 'b', toNodeId: 'c', points: [], createdAt: 'x' },
    { id: 'r3', fromNodeId: 'c', toNodeId: 'a', points: [], createdAt: 'x' },
  ];

  it('能找出与节点关联的全部道路（作为起点或终点）', () => {
    const affected = roadsAffectedByNodeDeletion('b', roads);
    expect(affected.map((r) => r.id).sort()).toEqual(['r1', 'r2']);
  });

  it('删除后不会留下悬空引用', () => {
    const affected = roadsAffectedByNodeDeletion('b', roads);
    const remaining = roads.filter((r) => !affected.some((a) => a.id === r.id));
    const nodesAfter = [A, C];
    expect(findDanglingRoads(remaining, nodesAfter)).toEqual([]);
  });

  it('未删除时能检测出悬空引用（防御性检查有效）', () => {
    // 若有人误删节点而未删道路，应能检测出来
    expect(findDanglingRoads(roads, [A, C])).toHaveLength(2);
  });
});

describe('roadDisplayName / composeRoadName', () => {
  it('优先使用自定义名称', () => {
    const road: Road = { id: 'r', fromNodeId: 'a', toNodeId: 'b', points: [], createdAt: 'x', name: '天河路' };
    expect(roadDisplayName(road, [A, B])).toBe('天河路');
  });

  it('无名称时用两端节点名拼接', () => {
    const road: Road = { id: 'r', fromNodeId: 'a', toNodeId: 'b', points: [], createdAt: 'x' };
    expect(roadDisplayName(road, [A, B])).toBe('A ⇄ B');
    expect(composeRoadName('A', 'B')).toBe('A ⇄ B');
  });
});
