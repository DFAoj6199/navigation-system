import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ZOOM_LIMITS,
  centeredOffset,
  clampOffset,
  computeFitZoom,
  isInsideImage,
  pixelToScreen,
  screenToPixel,
  zoomAt,
} from '../lib/viewport';

describe('computeFitZoom', () => {
  it('按 contain 语义取宽高比例较小者', () => {
    // 图片 2000x1000，视口 1000x1000 -> 宽受限，zoom=0.5
    expect(computeFitZoom(2000, 1000, { width: 1000, height: 1000 })).toBe(0.5);
    // 图片 1000x2000，视口 1000x1000 -> 高受限，zoom=0.5
    expect(computeFitZoom(1000, 2000, { width: 1000, height: 1000 })).toBe(0.5);
  });

  it('尺寸为 0 时退化为 1，避免除零', () => {
    expect(computeFitZoom(0, 100, { width: 100, height: 100 })).toBe(1);
    expect(computeFitZoom(100, 100, { width: 0, height: 100 })).toBe(1);
  });
});

describe('centeredOffset', () => {
  it('小图在大视口中居中', () => {
    const offset = centeredOffset(100, 50, 1, { width: 300, height: 200 });
    expect(offset).toEqual({ offsetX: 100, offsetY: 75 });
  });

  it('大图在小视口中为负偏移（左上角在视口外）', () => {
    const offset = centeredOffset(400, 200, 1, { width: 300, height: 200 });
    expect(offset).toEqual({ offsetX: -50, offsetY: 0 });
  });
});

describe('pixelToScreen / screenToPixel 互逆', () => {
  const ctx = { zoom: 1.75, offsetX: 37.5, offsetY: -12.25 };

  it('原点映射正确', () => {
    expect(pixelToScreen({ x: 0, y: 0 }, ctx)).toEqual({ x: 37.5, y: -12.25 });
  });

  it('任意像素点往返转换误差为 0', () => {
    const samples = [
      { x: 0, y: 0 },
      { x: 123.5, y: 456.25 },
      { x: 1999, y: 999 },
      { x: 0.1, y: 0.9 },
    ];
    for (const point of samples) {
      const screen = pixelToScreen(point, ctx);
      const back = screenToPixel(screen.x, screen.y, ctx);
      expect(back.x).toBeCloseTo(point.x, 10);
      expect(back.y).toBeCloseTo(point.y, 10);
    }
  });

  it('padding 偏移被正确扣除', () => {
    const withPadding = { ...ctx, paddingLeft: 12, paddingTop: 8 };
    const screen = pixelToScreen({ x: 100, y: 100 }, withPadding);
    const back = screenToPixel(screen.x, screen.y, withPadding);
    expect(back).toEqual({ x: 100, y: 100 });
  });

  it('zoom 为 1 时屏幕坐标 = 像素坐标 + 偏移', () => {
    const ctx1 = { zoom: 1, offsetX: 10, offsetY: 20 };
    expect(pixelToScreen({ x: 5, y: 7 }, ctx1)).toEqual({ x: 15, y: 27 });
    expect(screenToPixel(15, 27, ctx1)).toEqual({ x: 5, y: 7 });
  });
});

describe('zoomAt - 以锚点为中心缩放', () => {
  it('缩放前后锚点对应的像素坐标保持不变', () => {
    const ctx = { zoom: 1, offsetX: 0, offsetY: 0 };
    const anchorX = 250;
    const anchorY = 180;
    const before = screenToPixel(anchorX, anchorY, ctx);

    const next = zoomAt(anchorX, anchorY, ctx, 2.5);
    const after = screenToPixel(anchorX, anchorY, { ...next, zoom: next.zoom });

    expect(after.x).toBeCloseTo(before.x, 10);
    expect(after.y).toBeCloseTo(before.y, 10);
    expect(next.zoom).toBe(2.5);
  });

  it('多个连续缩放后锚点依旧不漂移', () => {
    const anchorX = 640;
    const anchorY = 360;
    let camera = { zoom: 0.3, offsetX: -120, offsetY: -80 };
    const pixelBefore = screenToPixel(anchorX, anchorY, camera);

    for (const factor of [1.15, 1.15, 1.15, 1 / 1.15, 3.2, 0.5]) {
      camera = zoomAt(anchorX, anchorY, camera, camera.zoom * factor);
    }
    const pixelAfter = screenToPixel(anchorX, anchorY, camera);
    expect(pixelAfter.x).toBeCloseTo(pixelBefore.x, 8);
    expect(pixelAfter.y).toBeCloseTo(pixelBefore.y, 8);
  });

  it('缩放倍率被限制在允许区间内', () => {
    const ctx = { zoom: 1, offsetX: 0, offsetY: 0 };
    const tooBig = zoomAt(0, 0, ctx, 999);
    expect(tooBig.zoom).toBe(DEFAULT_ZOOM_LIMITS.max);
    const tooSmall = zoomAt(0, 0, ctx, 0.0001);
    expect(tooSmall.zoom).toBe(DEFAULT_ZOOM_LIMITS.min);
  });
});

describe('clampOffset', () => {
  it('图片大于视口时限制在可视范围内', () => {
    // 渲染宽度 400，视口 300 -> offset 合法区间 [-100, 0]
    expect(clampOffset(-500, 400, 300, 1)).toBe(-100);
    expect(clampOffset(80, 400, 300, 1)).toBe(0);
    expect(clampOffset(-40, 400, 300, 1)).toBe(-40);
  });

  it('图片小于视口时限制在 [0, 视口-渲染尺寸]', () => {
    // 渲染宽度 100，视口 300 -> 区间 [0, 200]
    expect(clampOffset(-50, 100, 300, 1)).toBe(0);
    expect(clampOffset(250, 100, 300, 1)).toBe(200);
  });

  it('缩放后的渲染尺寸参与计算', () => {
    // 图片宽 100，zoom 3 -> 渲染 300，视口 400 -> 区间 [0, 100]
    expect(clampOffset(500, 100, 400, 3)).toBe(100);
  });
});

describe('isInsideImage', () => {
  it('边界包含在内', () => {
    expect(isInsideImage({ x: 0, y: 0 }, 100, 100)).toBe(true);
    expect(isInsideImage({ x: 100, y: 100 }, 100, 100)).toBe(true);
  });

  it('超出边界返回 false', () => {
    expect(isInsideImage({ x: -1, y: 10 }, 100, 100)).toBe(false);
    expect(isInsideImage({ x: 10, y: 101 }, 100, 100)).toBe(false);
  });
});
