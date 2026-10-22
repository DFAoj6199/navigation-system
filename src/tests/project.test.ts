import { describe, expect, it } from 'vitest';
import {
  PROJECT_FILE_APP,
  PROJECT_FILE_VERSION,
  makeProjectFileName,
  serializeProject,
  validateProject,
  type ProjectFile,
} from '../lib/project';
import { buildProjectFile, parseProjectText } from '../lib/projectIO';
import type { MapNode, Road } from '../types';
import type { MapScale } from '../lib/scale';

/**
 * 阶段6：项目文件序列化与校验。
 *
 * 校验必须做到：非法输入给出可读错误、不抛异常、且不会“部分通过”。
 */

const DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

function makeNodes(): MapNode[] {
  return [
    {
      id: 'n1',
      name: 'A',
      point: { x: 100, y: 200 },
      type: 'junction',
      createdAt: '2024-01-01T00:00:00.000Z',
    },
    {
      id: 'n2',
      name: 'B',
      point: { x: 400, y: 200 },
      type: 'entrance',
      createdAt: '2024-01-01T00:00:01.000Z',
    },
  ];
}

function makeRoads(): Road[] {
  return [
    {
      id: 'r1',
      fromNodeId: 'n1',
      toNodeId: 'n2',
      points: [
        { x: 200, y: 300 },
        { x: 300, y: 300 },
      ],
      createdAt: '2024-01-01T00:00:02.000Z',
    },
  ];
}

function makeScale(): MapScale {
  return {
    a: { x: 0, y: 0 },
    b: { x: 500, y: 0 },
    knownDistance: 500,
    unit: 'm',
    knownDistanceMeters: 500,
    pixelDistance: 500,
    metersPerPixel: 1,
    calibratedAt: '2024-01-01T00:00:03.000Z',
  };
}

function makeProject(): ProjectFile {
  return buildProjectFile({
    image: { fileName: 'tianhe.png', width: 1600, height: 1200, mimeType: 'image/png' },
    imageDataUrl: DATA_URL,
    nodes: makeNodes(),
    roads: makeRoads(),
    scale: makeScale(),
    searchLimits: { maxResults: 200, maxExpansions: 200000 },
  });
}

/**
 * 测试专用：构造脏数据时使用的宽松类型。
 * 这里刻意放弃类型安全（真实场景中这些数据来自不可信文件），
 * 因此仅在本测试文件内允许使用，并集中在这一个类型别名上。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseJson = any;

/** 深拷贝后修改某一字段，便于构造非法样本 */
function mutate<T>(obj: T, fn: (draft: LooseJson) => void): unknown {
  const copy = JSON.parse(JSON.stringify(obj)) as LooseJson;
  fn(copy);
  return copy;
}

describe('阶段6 - 项目文件结构', () => {
  it('构建的项目文件包含全部必需字段', () => {
    const p = makeProject();
    expect(p.app).toBe(PROJECT_FILE_APP);
    expect(p.version).toBe(PROJECT_FILE_VERSION);
    expect(p.image.fileName).toBe('tianhe.png');
    expect(p.image.width).toBe(1600);
    expect(p.image.height).toBe(1200);
    expect(p.image.dataUrl).toBe(DATA_URL);
    expect(p.nodes).toHaveLength(2);
    expect(p.roads).toHaveLength(1);
    expect(p.roads[0].points).toHaveLength(2);
    expect(p.scale?.metersPerPixel).toBe(1);
    expect(p.config.maxResults).toBe(200);
    expect(typeof p.config.exportedAt).toBe('string');
  });

  it('导出再导入后数据完全一致（往返一致）', () => {
    const original = makeProject();
    const text = serializeProject(original);
    const result = parseProjectText(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.nodes).toEqual(original.nodes);
    expect(result.project.roads).toEqual(original.roads);
    expect(result.project.scale).toEqual(original.scale);
    expect(result.project.image).toEqual(original.image);
  });

  it('序列化结果不包含函数或循环引用（可被 JSON 解析）', () => {
    const text = serializeProject(makeProject());
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it('导出文件名带时间戳且合法', () => {
    const name = makeProjectFileName('tianhe.png', new Date(2024, 4, 6, 7, 8, 9));
    expect(name).toBe('tianhe-20240506-070809.tianhe.json');
    // 非法字符被替换
    const weird = makeProjectFileName('a/b:c*.png');
    expect(weird).not.toContain('/');
    expect(weird).not.toContain(':');
  });
});

describe('阶段6 - 非法 JSON', () => {
  it('空文件给出明确提示', () => {
    const r = parseProjectText('   ');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('文件内容为空');
  });

  it('语法错误给出 JSON 格式错误提示', () => {
    const r = parseProjectText('{ "nodes": [ }');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('JSON 格式错误');
  });

  it('顶层不是对象（数组/字符串/数字）被拒绝', () => {
    for (const text of ['[]', '"hello"', '42', 'null']) {
      const r = parseProjectText(text);
      expect(r.ok).toBe(false);
    }
  });

  it('非本系统文件（app 不匹配）被拒绝', () => {
    const r = validateProject(mutate(makeProject(), (d) => { d.app = 'other-app'; }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('不是本系统导出的项目文件');
    expect(r.path).toBe('app');
  });

  it('版本号缺失或不受支持被拒绝', () => {
    const missing = validateProject(mutate(makeProject(), (d) => { delete d.version; }));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain('缺少格式版本号');

    const wrong = validateProject(mutate(makeProject(), (d) => { d.version = 99; }));
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error).toContain('不支持的文件版本');
  });
});

describe('阶段6 - 缺失地图', () => {
  it('缺少 image 字段被拒绝', () => {
    const r = validateProject(mutate(makeProject(), (d) => { delete d.image; }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('缺少地图图片信息');
    expect(r.path).toBe('image');
  });

  it('地图尺寸非法（0 / 负数 / 非整数）被拒绝', () => {
    for (const w of [0, -5, 12.5]) {
      const r = validateProject(mutate(makeProject(), (d) => { d.image.width = w; }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('宽度必须是正整数');
    }
  });

  it('地图尺寸缺失时不会崩溃', () => {
    const r = validateProject(mutate(makeProject(), (d) => { delete d.image.height; }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('高度必须是正整数');
  });

  it('图片数据格式错误被拒绝', () => {
    const r = validateProject(mutate(makeProject(), (d) => { d.image.dataUrl = 'not-a-data-url'; }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('内嵌图片数据格式错误');
  });

  it('允许 dataUrl 为 null（未内嵌底图的纯数据项目）', () => {
    const r = validateProject(mutate(makeProject(), (d) => { d.image.dataUrl = null; }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.project.image.dataUrl).toBeNull();
  });

  it('图片类型与 mimeType 不一致被拒绝', () => {
    const r = validateProject(
      mutate(makeProject(), (d) => {
        d.image.dataUrl = 'data:image/jpeg;base64,AAAA';
        d.image.mimeType = 'image/png';
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('不一致');
  });
});

describe('阶段6 - 节点校验', () => {
  it('节点 ID 重复被拒绝并指出具体 id', () => {
    const r = validateProject(
      mutate(makeProject(), (d) => {
        d.nodes[1].id = d.nodes[0].id;
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('节点 id 重复：n1');
    expect(r.path).toBe('nodes[1].id');
  });

  it('节点坐标为非数字被拒绝', () => {
    const r = validateProject(mutate(makeProject(), (d) => { d.nodes[0].point = { x: 'abc', y: 1 }; }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('必须是有限数字');
  });

  it('节点坐标明显越界被拒绝', () => {
    const r = validateProject(mutate(makeProject(), (d) => { d.nodes[0].point = { x: 999999, y: 5 }; }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('超出图片范围');
  });

  it('节点类型非法被拒绝', () => {
    const r = validateProject(mutate(makeProject(), (d) => { d.nodes[0].type = 'unknown'; }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('类型无效');
  });

  it('节点缺少 id 或名称为空被拒绝', () => {
    const noId = validateProject(mutate(makeProject(), (d) => { delete d.nodes[0].id; }));
    expect(noId.ok).toBe(false);
    const emptyName = validateProject(mutate(makeProject(), (d) => { d.nodes[0].name = '  '; }));
    expect(emptyName.ok).toBe(false);
  });

  it('空节点数组是合法的（允许没有节点的项目）', () => {
    const r = validateProject(
      mutate(makeProject(), (d) => {
        d.nodes = [];
        d.roads = [];
        d.scale = null;
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.project.nodes).toHaveLength(0);
  });

  it('nodes 不是数组被拒绝', () => {
    const r = validateProject(mutate(makeProject(), (d) => { d.nodes = {}; }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('必须是数组');
  });
});

describe('阶段6 - 道路校验', () => {
  it('道路起点引用不存在的节点被拒绝', () => {
    const r = validateProject(mutate(makeProject(), (d) => { d.roads[0].fromNodeId = 'ghost'; }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('无效的道路端点引用');
    expect(r.path).toBe('roads[0].fromNodeId');
  });

  it('道路终点引用不存在的节点被拒绝', () => {
    const r = validateProject(mutate(makeProject(), (d) => { d.roads[0].toNodeId = 'ghost'; }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('无效的道路端点引用');
  });

  it('道路缺少端点字段被拒绝', () => {
    const r = validateProject(mutate(makeProject(), (d) => { delete d.roads[0].fromNodeId; }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('缺少起点节点引用');
  });

  it('道路起终点相同被拒绝', () => {
    const r = validateProject(mutate(makeProject(), (d) => { d.roads[0].toNodeId = d.roads[0].fromNodeId; }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('起点与终点是同一个节点');
  });

  it('重复道路（同一对端点）被拒绝', () => {
    const r = validateProject(
      mutate(makeProject(), (d) => {
        d.roads.push({ ...d.roads[0], id: 'r2' });
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('重复');
  });

  it('道路 id 重复被拒绝', () => {
    const r = validateProject(
      mutate(makeProject(), (d) => {
        d.nodes.push({ ...d.nodes[0], id: 'n3', name: 'C', point: { x: 800, y: 200 } });
        d.roads.push({ ...d.roads[0], toNodeId: 'n3' });
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('道路 id 重复');
  });

  it('折线中间点坐标非法被拒绝', () => {
    const r = validateProject(mutate(makeProject(), (d) => { d.roads[0].points[0] = { x: 'x', y: 2 }; }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('中间点');
      expect(r.path).toBe('roads[0].points[0]');
    }
  });

  it('折线 points 不是数组被拒绝', () => {
    const r = validateProject(mutate(makeProject(), (d) => { d.roads[0].points = 'nope'; }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('折线中间点');
  });

  it('中间点为空数组是合法的（两端点直连）', () => {
    const r = validateProject(mutate(makeProject(), (d) => { d.roads[0].points = []; }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.project.roads[0].points).toEqual([]);
  });
});

describe('阶段6 - 比例尺校验', () => {
  it('scale 为 null 是合法的', () => {
    const r = validateProject(mutate(makeProject(), (d) => { d.scale = null; }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.project.scale).toBeNull();
  });

  it('换算系数非正被拒绝', () => {
    const r = validateProject(mutate(makeProject(), (d) => { d.scale.metersPerPixel = 0; }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('换算系数');
  });

  it('已知距离非正被拒绝', () => {
    const r = validateProject(mutate(makeProject(), (d) => { d.scale.knownDistance = -1; }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('已知距离必须是正数');
  });

  it('单位非法被拒绝', () => {
    const r = validateProject(mutate(makeProject(), (d) => { d.scale.unit = 'cm'; }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('比例尺单位无效');
  });

  it('像素距离为 0（校准点重合）被拒绝', () => {
    const r = validateProject(mutate(makeProject(), (d) => { d.scale.pixelDistance = 0; }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('像素距离');
  });
});

describe('阶段6 - 校验的健壮性', () => {
  it('任何非法输入都不抛出异常', () => {
    const samples: unknown[] = [
      null,
      undefined,
      0,
      '',
      [],
      {},
      { version: 1 },
      { version: 1, image: null },
      { version: 1, image: {}, nodes: null, roads: null },
      { version: 1, image: { fileName: 'a', width: 1, height: 1, mimeType: 'image/png', dataUrl: null }, nodes: [{}], roads: [] },
    ];
    for (const sample of samples) {
      expect(() => validateProject(sample)).not.toThrow();
    }
  });

  it('校验失败时不返回部分数据（只有 ok:false 与错误信息）', () => {
    const r = validateProject(mutate(makeProject(), (d) => { d.roads[0].fromNodeId = 'ghost'; }));
    expect(r.ok).toBe(false);
    expect(Object.keys(r).sort()).toEqual(['error', 'ok', 'path']);
  });
});
