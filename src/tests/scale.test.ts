import { describe, expect, it } from 'vitest';
import {
  createMapScale,
  describeScale,
  formatDistance,
  pixelDistanceBetween,
  pixelsToMeters,
} from '../lib/scale';
import { polylineLength } from '../lib/roads';
import type { PixelPoint } from '../types';

const W = 1600;
const H = 1200;

// 人工可计算的校准：A(0,0) 到 B(300,400)，像素距离 = 500（3-4-5 直角三角形）
const A = { x: 0, y: 0 };
const B = { x: 300, y: 400 };

describe('比例尺校准 - 人工可计算用例', () => {
  it('像素距离按欧氏距离计算：√(300²+400²)=500', () => {
    expect(pixelDistanceBetween(A, B)).toBeCloseTo(500, 9);
  });

  it('已知 500 米 / 500 像素 → 1 米每像素', () => {
    const r = createMapScale(A, B, 500, 'm', W, H);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scale.pixelDistance).toBeCloseTo(500, 9);
    expect(r.scale.knownDistanceMeters).toBeCloseTo(500, 9);
    expect(r.scale.metersPerPixel).toBeCloseTo(1, 9);
  });

  it('已知 1 千米 / 500 像素 → 2 米每像素（单位换算正确）', () => {
    const r = createMapScale(A, B, 1, 'km', W, H);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scale.knownDistanceMeters).toBeCloseTo(1000, 9);
    expect(r.scale.metersPerPixel).toBeCloseTo(2, 9);
  });

  it('已知 0.5 千米 与 500 米 得到相同系数', () => {
    const r1 = createMapScale(A, B, 0.5, 'km', W, H);
    const r2 = createMapScale(A, B, 500, 'm', W, H);
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.scale.metersPerPixel).toBeCloseTo(r2.scale.metersPerPixel, 12);
  });
});

describe('比例尺校验 - 非法输入必须被拒绝', () => {
  it('未选择校准点', () => {
    const r = createMapScale(null, B, 500, 'm', W, H);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('两个校准点');
  });

  it('两点重合（像素距离为 0）', () => {
    const r = createMapScale(A, { ...A }, 500, 'm', W, H);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('重合');
  });

  it('距离为 0 / 负数 / 非数字 / 空', () => {
    for (const value of [0, -5, 'abc', '', '   ']) {
      const r = createMapScale(A, B, value as never, 'm', W, H);
      expect(r.ok).toBe(false);
    }
  });

  it('单位非法', () => {
    const r = createMapScale(A, B, 500, 'ft', W, H);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('单位');
  });

  it('校准点超出地图范围', () => {
    const r = createMapScale({ x: -10, y: 0 }, B, 500, 'm', W, H);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('超出地图范围');
  });
});

describe('像素长度 → 实际距离', () => {
  const scaleResult = createMapScale(A, B, 500, 'm', W, H);
  if (!scaleResult.ok) throw new Error('校准应当成功');
  const scale = scaleResult.scale;

  it('已知折线：4 段各 √(100²+200²) 累加 = 894.427，换算 894.4 米', () => {
    const polyline: PixelPoint[] = [
      { x: 100, y: 100 },
      { x: 200, y: 300 },
      { x: 400, y: 400 },
      { x: 600, y: 300 },
      { x: 700, y: 100 },
    ];
    const px = polylineLength(polyline);
    // 人工推导：4 × √(100²+200²) = 4 × 223.6068 = 894.4272
    expect(px).toBeCloseTo(894.4272, 3);
    const meters = pixelsToMeters(px, scale);
    expect(meters).toBeCloseTo(894.4272, 3);
    // 1 米/像素时，米数应与像素数一一对应
    expect(meters).toBeCloseTo(px, 9);
  });

  it('未校准时返回 null，绝不返回像素冒充米', () => {
    expect(pixelsToMeters(1234, null)).toBeNull();
  });

  it('非法系数时不返回数字', () => {
    const broken = { ...scale, metersPerPixel: 0 };
    expect(pixelsToMeters(100, broken)).toBeNull();
    const broken2 = { ...scale, metersPerPixel: NaN };
    expect(pixelsToMeters(100, broken2)).toBeNull();
  });
});

describe('距离格式化', () => {
  it('小于 1000 米用米，保留 1 位小数', () => {
    expect(formatDistance(894.4272)).toBe('894.4 米');
    expect(formatDistance(0)).toBe('0.0 米');
    expect(formatDistance(999.94)).toBe('999.9 米');
  });

  it('大于等于 1000 米换算为千米，保留 2 位小数', () => {
    expect(formatDistance(1000)).toBe('1.00 千米');
    expect(formatDistance(1500)).toBe('1.50 千米');
    expect(formatDistance(12345)).toBe('12.35 千米');
  });

  it('非有限值不显示 NaN', () => {
    expect(formatDistance(NaN)).toBe('—');
    expect(formatDistance(Infinity)).toBe('—');
  });
});

describe('比例尺描述', () => {
  it('展示每像素米数', () => {
    const r = createMapScale(A, B, 500, 'm', W, H);
    if (!r.ok) throw new Error('校准应当成功');
    expect(describeScale(r.scale)).toBe('1 像素 ≈ 1.0000 米');
  });
});

describe('校准点与视图无关（缩放拖动不影响系数）', () => {
  it('相同像素坐标反复校准得到相同系数，与任何视图参数无关', () => {
    const r1 = createMapScale(A, B, 250, 'm', W, H);
    const r2 = createMapScale(A, B, 250, 'm', W, H);
    if (!r1.ok || !r2.ok) throw new Error('校准应当成功');
    expect(r1.scale.metersPerPixel).toBe(r2.scale.metersPerPixel);
    // 0.5 米/像素
    expect(r1.scale.metersPerPixel).toBeCloseTo(0.5, 9);
  });
});

describe('比例尺变化后长度按比例更新（人工核对）', () => {
  const polyline: PixelPoint[] = [
    { x: 0, y: 0 },
    { x: 600, y: 0 },
  ];
  const px = polylineLength(polyline); // 600

  it('系数 1 米/像素 → 600 米；系数 2 米/像素 → 1200 米', () => {
    const s1 = createMapScale(A, B, 500, 'm', W, H); // 1 m/px
    const s2 = createMapScale(A, B, 1000, 'm', W, H); // 2 m/px
    if (!s1.ok || !s2.ok) throw new Error('校准应当成功');
    expect(pixelsToMeters(px, s1.scale)).toBeCloseTo(600, 9);
    expect(pixelsToMeters(px, s2.scale)).toBeCloseTo(1200, 9);
    // 比例恰好翻倍
    expect(pixelsToMeters(px, s2.scale)! / pixelsToMeters(px, s1.scale)!).toBeCloseTo(2, 12);
  });

  it('像素长度本身不受比例尺影响', () => {
    expect(px).toBeCloseTo(600, 9);
  });
});
