import type { Camera, PixelPoint } from '../types';

/**
 * 坐标变换核心。
 *
 * 渲染约定（唯一变换源）：
 *   屏幕坐标 = 图片像素坐标 * zoom + 平移量 + 容器内边距偏移
 *
 * 其中：
 *   - zoom      视图缩放倍率
 *   - offsetX/Y 平移量，单位为 CSS 像素，表示“图片左上角相对容器内容区左上角的位置”
 *   - padding   容器内容区（扣除滚动条/内边距后的可视区域）左上角在容器坐标系中的位置
 *
 * 这样设计的收益：
 *   1. 正向（像素->屏幕）与反向（屏幕->像素）互为精确逆运算，点击落点不会漂移；
 *   2. 缩放、拖动只改 zoom/offset，业务数据中的像素坐标完全不变；
 *   3. 窗口 resize 只需重算 fitScale / 夹取平移量，节点仍然贴合原图。
 */

/** 视口尺寸（CSS 像素） */
export interface ViewportSize {
  width: number;
  height: number;
}

export interface ZoomLimits {
  min: number;
  max: number;
}

export const DEFAULT_ZOOM_LIMITS: ZoomLimits = { min: 0.05, max: 16 };

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 让整张图片刚好装进视口所需的缩放倍率（contain 语义）。
 */
export function computeFitZoom(
  imageWidth: number,
  imageHeight: number,
  viewport: ViewportSize,
): number {
  if (imageWidth <= 0 || imageHeight <= 0) return 1;
  if (viewport.width <= 0 || viewport.height <= 0) return 1;
  return Math.min(viewport.width / imageWidth, viewport.height / imageHeight);
}

/**
 * 计算居中显示时的平移量：
 * 使图片可视中心与视口中心重合。
 */
export function centeredOffset(
  imageWidth: number,
  imageHeight: number,
  zoom: number,
  viewport: ViewportSize,
): { offsetX: number; offsetY: number } {
  return {
    offsetX: (viewport.width - imageWidth * zoom) / 2,
    offsetY: (viewport.height - imageHeight * zoom) / 2,
  };
}

/**
 * 平移量夹取：保证图片不会完全跑出视口。
 * 允许图片比视口小（此时给一点最小可见余量），也允许图片比视口大（正常滚动）。
 */
export function clampOffset(
  offset: number,
  imageLength: number,
  viewportLength: number,
  zoom: number,
): number {
  const rendered = imageLength * zoom;
  if (rendered <= viewportLength) {
    // 图片小于视口：允许在 [0, viewport - rendered] 之间自由摆放（可露背景）
    return clamp(offset, 0, viewportLength - rendered);
  }
  // 图片大于视口：限制在 [viewport - rendered, 0]，避免拖到完全看不见
  return clamp(offset, viewportLength - rendered, 0);
}

export interface ViewContext {
  zoom: number;
  offsetX: number;
  offsetY: number;
  /** 容器内容区左上角在宿主坐标系中的位置（通常是 padding + 滚动偏移） */
  paddingLeft?: number;
  paddingTop?: number;
}

/**
 * 像素坐标 -> 屏幕坐标（相对容器内容区左上角）。
 */
export function pixelToScreen(
  point: PixelPoint,
  ctx: ViewContext,
): { x: number; y: number } {
  return {
    x: point.x * ctx.zoom + ctx.offsetX + (ctx.paddingLeft ?? 0),
    y: point.y * ctx.zoom + ctx.offsetY + (ctx.paddingTop ?? 0),
  };
}

/**
 * 屏幕坐标 -> 像素坐标。
 *
 * @param screenX 相对“容器内容区左上角”的 CSS 像素坐标
 *   = 鼠标事件的 clientX - rect.left - paddingLeft
 * @returns 原始图片像素坐标（可能是小数，调用方决定是否取整）
 */
export function screenToPixel(
  screenX: number,
  screenY: number,
  ctx: ViewContext,
): { x: number; y: number } {
  return {
    x: (screenX - (ctx.paddingLeft ?? 0) - ctx.offsetX) / ctx.zoom,
    y: (screenY - (ctx.paddingTop ?? 0) - ctx.offsetY) / ctx.zoom,
  };
}

/**
 * 以某个屏幕锚点为中心缩放（“鼠标位置不动的缩放”）。
 * 返回新的缩放倍率与平移量。
 */
export function zoomAt(
  anchorScreenX: number,
  anchorScreenY: number,
  ctx: ViewContext,
  nextZoom: number,
  limits: ZoomLimits = DEFAULT_ZOOM_LIMITS,
): Camera {
  const zoom = clamp(nextZoom, limits.min, limits.max);
  const paddingLeft = ctx.paddingLeft ?? 0;
  const paddingTop = ctx.paddingTop ?? 0;
  // 锚点对应的像素坐标在缩放前后必须保持不动
  const pixel = screenToPixel(anchorScreenX, anchorScreenY, ctx);
  return {
    zoom,
    offsetX: anchorScreenX - paddingLeft - pixel.x * zoom,
    offsetY: anchorScreenY - paddingTop - pixel.y * zoom,
  };
}

/** 判断像素坐标是否落在图片范围内（含边界，右边/下边取 width/height 视为边界内） */
export function isInsideImage(
  point: PixelPoint,
  imageWidth: number,
  imageHeight: number,
): boolean {
  return point.x >= 0 && point.x <= imageWidth && point.y >= 0 && point.y <= imageHeight;
}

/** 四舍五入到整数像素 */
export function roundPixel(point: PixelPoint): PixelPoint {
  return { x: Math.round(point.x), y: Math.round(point.y) };
}
