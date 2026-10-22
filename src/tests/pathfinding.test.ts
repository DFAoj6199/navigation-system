import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SEARCH_LIMITS,
  buildGraph,
  findAllSimplePaths,
  findShortestPath,
  formatNodeSequence,
  formatPixelLength,
  roadPixelLength,
} from '../lib/pathfinding';
import { createRoad } from '../lib/roads';
import type { MapNode, PixelPoint, Road } from '../types';

/**
 * 本文件的核心原则：预期值全部由人工推导，并写在注释里。
 * 不依赖程序自身生成预期，避免“程序算错、测试也跟着错”。
 */

function node(id: string, name: string, x: number, y: number): MapNode {
  return { id, name, point: { x, y }, type: 'junction', createdAt: '2024-01-01T00:00:00.000Z' };
}

/** 便捷构造道路（points 为中间点） */
function road(from: string, to: string, points: PixelPoint[] = []): Road {
  return createRoad(from, to, points);
}

describe('① 只有一条道路的简单图', () => {
  // A(0,0) --B(300,400)-- C(600,800)
  // 人工推导：直线距离 = hypot(300,400) = 500（3-4-5 直角三角形）
  const A = node('A', 'A', 0, 0);
  const B = node('B', 'B', 300, 400);
  const C = node('C', 'C', 600, 800);
  const nodes = [A, B, C];
  const roads = [road('A', 'B'), road('B', 'C')];

  it('A->C 只有 1 条简单路径 A->B->C，长度 1000', () => {
    const out = findAllSimplePaths(nodes, roads, 'A', 'C');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.paths).toHaveLength(1);
    expect(out.result.paths[0].nodeIds).toEqual(['A', 'B', 'C']);
    // 500 + 500 = 1000（人工推导）
    expect(out.result.paths[0].length).toBeCloseTo(1000, 6);
    expect(out.result.complete).toBe(true);
  });

  it('Dijkstra 最短路径同为 A->B->C，长度 1000', () => {
    const out = findShortestPath(nodes, roads, 'A', 'C');
    expect(out.ok).toBe(true);
    if (!out.ok || !out.result.path) throw new Error('应找到路径');
    expect(out.result.path.nodeIds).toEqual(['A', 'B', 'C']);
    expect(out.result.path.length).toBeCloseTo(1000, 6);
  });

  it('反向 C->A 同样可达（双向道路）', () => {
    const out = findShortestPath(nodes, roads, 'C', 'A');
    expect(out.ok).toBe(true);
    if (!out.ok || !out.result.path) throw new Error('应找到路径');
    expect(out.result.path.nodeIds).toEqual(['C', 'B', 'A']);
    expect(out.result.path.length).toBeCloseTo(1000, 6);
  });
});

describe('② 存在两条不同路线的分叉图', () => {
  // A(0,0) 分叉到 B(100,100) 与 C(100,-100)，二者都汇聚到 D(200,0)
  // 人工推导：
  //   路径1 A->B->D，长度 = 100√2 + 100√2 = 200√2 ≈ 282.842712
  //   路径2 A->C->D，长度同上 ≈ 282.842712
  //   共 2 条简单路径
  const A = node('A', 'A', 0, 0);
  const B = node('B', 'B', 100, 100);
  const C = node('C', 'C', 100, -100);
  const D = node('D', 'D', 200, 0);
  const nodes = [A, B, C, D];
  const roads = [road('A', 'B'), road('B', 'D'), road('A', 'C'), road('C', 'D')];
  const R2 = Math.SQRT2 * 100;

  it('恰好枚举出 2 条简单路径', () => {
    const out = findAllSimplePaths(nodes, roads, 'A', 'D');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.paths).toHaveLength(2);
    const seqs = out.result.paths.map((p) => p.nodeIds.join('->')).sort();
    expect(seqs).toEqual(['A->B->D', 'A->C->D']);
    expect(out.result.complete).toBe(true);
    for (const p of out.result.paths) expect(p.length).toBeCloseTo(R2 + R2, 6);
  });

  it('Dijkstra 返回两条等长路径之一，长度正确', () => {
    const out = findShortestPath(nodes, roads, 'A', 'D');
    expect(out.ok).toBe(true);
    if (!out.ok || !out.result.path) throw new Error('应找到路径');
    expect(out.result.path.length).toBeCloseTo(2 * R2, 6);
    expect(['A->B->D', 'A->C->D']).toContain(out.result.path.nodeIds.join('->'));
  });
});

describe('③ 存在环路的图', () => {
  // 完全图 K4（4 个节点两两相连），节点放在边长为 100 的正方形四角
  // A(0,0) B(100,0) C(100,100) D(0,100)
  // 人工推导所有 A->C 的简单路径（不重复节点）：
  //   长度2：A-C                                  → 1 条
  //   长度3：A-B-C、A-D-C                         → 2 条
  //   长度4：A-B-D-C、A-D-B-C                     → 2 条
  // 合计 5 条。
  // （首版推导漏了 A-D-C，被程序输出 A->D->C 纠正——此处保留记录。）
  const A = node('A', 'A', 0, 0);
  const B = node('B', 'B', 100, 0);
  const C = node('C', 'C', 100, 100);
  const D = node('D', 'D', 0, 100);
  const nodes = [A, B, C, D];
  const roads = [
    road('A', 'B'), road('B', 'C'), road('C', 'D'), road('D', 'A'), // 外环
    road('A', 'C'), road('B', 'D'), // 对角线
  ];

  it('K4 中 A->C 恰好有 5 条简单路径，且都不重复节点', () => {
    const out = findAllSimplePaths(nodes, roads, 'A', 'C');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const seqs = out.result.paths.map((p) => p.nodeIds.join('->')).sort();
    expect(seqs).toEqual(['A->B->C', 'A->B->D->C', 'A->C', 'A->D->B->C', 'A->D->C']);
    expect(out.result.complete).toBe(true);
    // 每条路径内部节点不重复
    for (const p of out.result.paths) {
      expect(new Set(p.nodeIds).size).toBe(p.nodeIds.length);
    }
  });

  it('K4 最短路径是直连 A->C，长度 100√2', () => {
    const out = findShortestPath(nodes, roads, 'A', 'C');
    expect(out.ok).toBe(true);
    if (!out.ok || !out.result.path) throw new Error('应找到路径');
    expect(out.result.path.nodeIds).toEqual(['A', 'C']);
    expect(out.result.path.length).toBeCloseTo(Math.SQRT2 * 100, 6);
  });
});

describe('④ 起点与终点不连通的图', () => {
  // A-B 相连，C-D 相连，两组之间没有道路
  const A = node('A', 'A', 0, 0);
  const B = node('B', 'B', 10, 0);
  const C = node('C', 'C', 500, 500);
  const D = node('D', 'D', 510, 500);
  const nodes = [A, B, C, D];
  const roads = [road('A', 'B'), road('C', 'D')];

  it('简单路径搜索返回 0 条且标记完整（不是被截断）', () => {
    const out = findAllSimplePaths(nodes, roads, 'A', 'D');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.paths).toHaveLength(0);
    expect(out.result.complete).toBe(true);
    expect(out.result.truncated).toBe(false);
  });

  it('Dijkstra 返回 null（无路径）', () => {
    const out = findShortestPath(nodes, roads, 'A', 'D');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.path).toBeNull();
  });
});

describe('⑤ 起点与终点相同', () => {
  const A = node('A', 'A', 0, 0);
  const B = node('B', 'B', 100, 0);
  const nodes = [A, B];
  const roads = [road('A', 'B')];

  it('简单路径：稳定返回 1 条仅含起点的零长度路径', () => {
    const out = findAllSimplePaths(nodes, roads, 'A', 'A');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.paths).toHaveLength(1);
    expect(out.result.paths[0].nodeIds).toEqual(['A']);
    expect(out.result.paths[0].length).toBe(0);
    expect(out.result.complete).toBe(true);
  });

  it('简单路径：即使图里有环，也不会死循环、结果不变', () => {
    // A-B-C-A 构成环，起点=终点仍应稳定返回单节点路径，不能无限展开
    const C = node('C', 'C', 50, 80);
    const out = findAllSimplePaths([A, B, C], [road('A', 'B'), road('B', 'C'), road('C', 'A')], 'A', 'A');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.paths).toHaveLength(1);
    expect(out.result.paths[0].nodeIds).toEqual(['A']);
    expect(out.result.paths[0].length).toBe(0);
  });

  it('Dijkstra：同样返回零长度单节点路径', () => {
    const out = findShortestPath(nodes, roads, 'A', 'A');
    expect(out.ok).toBe(true);
    if (!out.ok || !out.result.path) throw new Error('应返回路径');
    expect(out.result.path.nodeIds).toEqual(['A']);
    expect(out.result.path.length).toBe(0);
  });
});

describe('⑥ 含多个中间折线点，但节点连接关系相同的图', () => {
  // 两张图节点与连接关系完全一致，只有折线中间点不同：
  //   直连组：  A(0,0) ---- B(300,0)
  //   绕行组：  A(0,0) -> (300,0) 之间加了中间点 (0,400)、(300,400)
  //             实际折线长度 = 400 + 300 + 400 = 1100
  // 人工推导：两图“节点序列”相同（A->B），但长度必须不同，分别为 300 与 1100。
  const A = node('A', 'A', 0, 0);
  const B = node('B', 'B', 300, 0);
  const nodes = [A, B];

  const straight = [road('A', 'B')];
  const detour = [road('A', 'B', [{ x: 0, y: 400 }, { x: 300, y: 400 }])];

  it('连接关系相同 → 路径数量与节点序列相同', () => {
    const s1 = findAllSimplePaths(nodes, straight, 'A', 'B');
    const s2 = findAllSimplePaths(nodes, detour, 'A', 'B');
    expect(s1.ok && s2.ok).toBe(true);
    if (!s1.ok || !s2.ok) return;
    expect(s1.result.paths).toHaveLength(1);
    expect(s2.result.paths).toHaveLength(1);
    expect(s1.result.paths[0].nodeIds).toEqual(s2.result.paths[0].nodeIds);
    expect(s1.result.paths[0].nodeIds).toEqual(['A', 'B']);
  });

  it('长度按全部折线段计算：300 与 1100（不是 300 与 300）', () => {
    const s1 = findAllSimplePaths(nodes, straight, 'A', 'B');
    const s2 = findAllSimplePaths(nodes, detour, 'A', 'B');
    if (!s1.ok || !s2.ok) throw new Error('搜索失败');
    expect(s1.result.paths[0].length).toBeCloseTo(300, 6);
    expect(s2.result.paths[0].length).toBeCloseTo(1100, 6);
  });

  it('roadPixelLength 同样按折线累加，而非端点直线距离', () => {
    expect(roadPixelLength(detour[0], A, B)).toBeCloseTo(1100, 6);
    // 端点直线距离只有 300，必须能区分开
    expect(roadPixelLength(detour[0], A, B)).not.toBeCloseTo(300, 6);
  });

  it('含中间点的绕行道路会让 Dijkstra 选另一条更短的平行路线', () => {
    // A(0,0)、B(300,0)、C(0,150)：A->C->B 长度 = 150 + hypot(300,150)=150+335.41=485.41
    // 而 A->B 直连 300 更短，所以最短仍是直连
    // 换成 A->B 绕行 1100 时，A->C->B(485.41) 应胜出
    const C = node('C', 'C', 0, 150);
    const nodes3 = [A, B, C];
    const roads3 = [road('A', 'B', [{ x: 0, y: 400 }, { x: 300, y: 400 }]), road('A', 'C'), road('C', 'B')];
    const out = findShortestPath(nodes3, roads3, 'A', 'B');
    expect(out.ok).toBe(true);
    if (!out.ok || !out.result.path) throw new Error('应找到路径');
    expect(out.result.path.nodeIds).toEqual(['A', 'C', 'B']);
    expect(out.result.path.length).toBeCloseTo(150 + Math.hypot(300, 150), 6);
  });
});

describe('结果数量保护与完整性标记', () => {
  // 构造一个会产生大量简单路径的稠密图：
  // 6 个节点两两相连（K6），起点 A、终点 B。
  // A->B 的简单路径数量 = sum_{k=0..4} P(4, k) = 1 + 4 + 12 + 24 + 24 = 65
  const labels = ['A', 'B', 'C', 'D', 'E', 'F'];
  const nodes = labels.map((l, i) => node(l, l, i * 10, (i % 2) * 7));
  const roads: Road[] = [];
  for (let i = 0; i < labels.length; i += 1) {
    for (let j = i + 1; j < labels.length; j += 1) {
      roads.push(road(labels[i], labels[j]));
    }
  }

  it('K6 中 A->B 恰好 65 条简单路径（人工推导 1+4+12+24+24）', () => {
    const out = findAllSimplePaths(nodes, roads, 'A', 'B', { maxResults: 10_000, maxExpansions: 1_000_000 });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.paths).toHaveLength(65);
    expect(out.result.complete).toBe(true);
  });

  it('达到 maxResults 时标记 truncated 且 complete=false', () => {
    const out = findAllSimplePaths(nodes, roads, 'A', 'B', { maxResults: 5, maxExpansions: 1_000_000 });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.paths).toHaveLength(5);
    expect(out.result.truncated).toBe(true);
    expect(out.result.complete).toBe(false);
    expect(out.result.truncatedReason).toBe('maxResults');
  });

  it('达到 maxExpansions 时同样标记不完整', () => {
    const out = findAllSimplePaths(nodes, roads, 'A', 'B', { maxResults: 10_000, maxExpansions: 3 });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.truncated).toBe(true);
    expect(out.result.complete).toBe(false);
    expect(out.result.truncatedReason).toBe('maxExpansions');
  });

  it('默认限制是明确的、可展示给用户的数值', () => {
    expect(DEFAULT_SEARCH_LIMITS.maxResults).toBeGreaterThan(0);
    expect(DEFAULT_SEARCH_LIMITS.maxExpansions).toBeGreaterThan(0);
  });
});

describe('图构建与安全性', () => {
  const A = node('A', 'A', 0, 0);
  const B = node('B', 'B', 100, 0);

  it('双向：每条道路在邻接表中生成两条有向边', () => {
    const g = buildGraph([A, B], [road('A', 'B')]);
    expect(g.get('A')).toHaveLength(1);
    expect(g.get('B')).toHaveLength(1);
    expect(g.get('A')![0].to).toBe('B');
    expect(g.get('B')![0].to).toBe('A');
    expect(g.get('A')![0].length).toBeCloseTo(100, 6);
  });

  it('悬空引用（端点节点不存在）的道路被忽略，不崩溃', () => {
    const g = buildGraph([A], [road('A', 'MISSING')]);
    expect(g.get('A')).toHaveLength(0);
  });

  it('搜索不会修改传入的道路与节点（不增删改）', () => {
    const nodes = [A, B];
    const roads = [road('A', 'B', [{ x: 50, y: 50 }])];
    const nodesSnapshot = JSON.stringify(nodes);
    const roadsSnapshot = JSON.stringify(roads);
    findAllSimplePaths(nodes, roads, 'A', 'B');
    findShortestPath(nodes, roads, 'A', 'B');
    expect(JSON.stringify(nodes)).toBe(nodesSnapshot);
    expect(JSON.stringify(roads)).toBe(roadsSnapshot);
  });

  it('起点或终点不存在时返回明确错误', () => {
    const a = findAllSimplePaths([A, B], [], 'A', 'ZZZ');
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.error).toContain('不存在');
    const b = findShortestPath([A, B], [], 'ZZZ', 'A');
    expect(b.ok).toBe(false);
  });

  it('未选择起终点时返回明确错误', () => {
    const a = findAllSimplePaths([A, B], [], '', 'B');
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.error).toContain('请选择');
  });
});

describe('展示格式', () => {
  const A = node('A', '起点站', 0, 0);
  const B = node('B', '终点站', 100, 0);

  it('节点序列格式为 "A -> B"', () => {
    expect(formatNodeSequence(['A', 'B'], [A, B])).toBe('起点站 -> 终点站');
  });

  it('长度单位是像素，绝不写成米', () => {
    const text = formatPixelLength(1234.56);
    expect(text).toContain('像素');
    expect(text).not.toContain('米');
    expect(text).not.toContain('m ');
    expect(text).toBe('1234.6 像素');
  });
});
