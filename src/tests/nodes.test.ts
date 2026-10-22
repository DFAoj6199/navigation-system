import { describe, expect, it } from 'vitest';
import {
  createNode,
  nextNodeName,
  parseCoordinateInput,
  validateNodeName,
  validateNodePoint,
} from '../lib/nodes';

describe('parseCoordinateInput', () => {
  it('接受整数、小数、负数与正号', () => {
    expect(parseCoordinateInput('120', 'X')).toEqual({ ok: true, value: 120 });
    expect(parseCoordinateInput(' 99.5 ', 'X')).toEqual({ ok: true, value: 99.5 });
    expect(parseCoordinateInput('-3', 'Y')).toEqual({ ok: true, value: -3 });
    expect(parseCoordinateInput('+7', 'Y')).toEqual({ ok: true, value: 7 });
    expect(parseCoordinateInput('.5', 'X')).toEqual({ ok: true, value: 0.5 });
  });

  it('拒绝空值', () => {
    const result = parseCoordinateInput('   ', 'X');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('不能为空');
  });

  it('拒绝非数字文本', () => {
    for (const bad of ['abc', '1a', 'NaN', 'Infinity', '--2', '1.2.3']) {
      const result = parseCoordinateInput(bad, 'Y');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('必须是数字');
    }
  });
});

describe('validateNodePoint', () => {
  const W = 1000;
  const H = 800;

  it('范围内取整后通过', () => {
    const result = validateNodePoint(500.6, 400.4, W, H);
    expect(result).toEqual({ ok: true, point: { x: 501, y: 400 } });
  });

  it('边界值 0 与 width/height 通过', () => {
    expect(validateNodePoint(0, 0, W, H)).toEqual({ ok: true, point: { x: 0, y: 0 } });
    expect(validateNodePoint(W, H, W, H)).toEqual({ ok: true, point: { x: W, y: H } });
  });

  it('X 超范围给出明确错误', () => {
    const result = validateNodePoint(1001, 400, W, H);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('X 坐标 1001');
      expect(result.error).toContain('0 ~ 1000');
    }
  });

  it('Y 负值超范围给出明确错误', () => {
    const result = validateNodePoint(10, -5, W, H);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Y 坐标 -5');
      expect(result.error).toContain('0 ~ 800');
    }
  });

  it('NaN 被拒绝', () => {
    const result = validateNodePoint(Number.NaN, 10, W, H);
    expect(result.ok).toBe(false);
  });
});

describe('validateNodeName', () => {
  it('非空且长度合规通过', () => {
    expect(validateNodeName('天河体育中心')).toBeNull();
  });

  it('空名称被拒绝', () => {
    expect(validateNodeName('   ')).toContain('不能为空');
  });

  it('超长名称被拒绝', () => {
    expect(validateNodeName('长'.repeat(41))).toContain('40');
  });
});

describe('createNode / nextNodeName', () => {
  it('生成唯一 ID 并保存整数像素坐标', () => {
    const a = createNode({ x: 10.6, y: 20.2 }, 'A');
    const b = createNode({ x: 10.6, y: 20.2 }, 'A');
    expect(a.id).not.toBe(b.id);
    expect(a.point).toEqual({ x: 11, y: 20 });
    expect(a.name).toBe('A');
  });

  it('自动名称从已有数量顺延并避开重名', () => {
    const one = createNode({ x: 0, y: 0 }, '节点 1');
    const two = createNode({ x: 1, y: 1 }, '节点 2');
    expect(nextNodeName([one, two])).toBe('节点 3');
    // 若“节点 3”已存在，应继续顺延
    const three = createNode({ x: 2, y: 2 }, '节点 3');
    expect(nextNodeName([one, two, three])).toBe('节点 4');
  });

  it('新建节点默认类型为地标（地标在非节点管理页签也可见）', () => {
    // 路口类型只在“节点管理”页签显示，若默认建成路口，
    // 用户新加的节点在其他页签会“看不见”，因此默认必须是地标。
    expect(createNode({ x: 0, y: 0 }, 'A').type).toBe('landmark');
    // 仍可显式指定为路口
    expect(createNode({ x: 0, y: 0 }, 'B', 'junction').type).toBe('junction');
  });
});
