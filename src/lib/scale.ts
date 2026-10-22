/**
 * 比例尺校准与距离换算的纯函数。
 *
 * 【核心模型】
 * 校准 = 在地图上指定两个点（原始图片像素坐标）+ 这两点的已知真实距离。
 *   米/像素 系数 metersPerPixel = 实际距离(米) / 两点像素距离
 * 之后：实际距离(米) = 像素长度 × metersPerPixel
 *
 * 【重要限制】
 * - 校准点与所有长度都基于**原始图片像素坐标**，与视图层 zoom/offset 无关，
 *   因此缩放、拖动地图绝不会改变系数与已算出的实际长度。
 * - 本算法假定图片为等比例（各方向像素代表的实际长度相同）。
 *   若底图存在透视变形或横纵比例不一致，结果只是**近似估算**，
 *   不具备测绘级精度。
 */

/** 支持的距离单位 */
export type DistanceUnit = 'm' | 'km';

export const DISTANCE_UNIT_LABELS: Record<DistanceUnit, string> = {
  m: '米',
  km: '千米',
};

/** 换算到“米”的倍数 */
const UNIT_TO_METERS: Record<DistanceUnit, number> = {
  m: 1,
  km: 1000,
};

/** 校准点（原始图片像素坐标），只保存像素坐标，不保存任何屏幕坐标 */
export interface ScalePoint {
  x: number;
  y: number;
}

/** 比例尺校准数据（保存在项目状态中） */
export interface MapScale {
  /** 校准点 A（原始像素坐标） */
  a: ScalePoint;
  /** 校准点 B（原始像素坐标） */
  b: ScalePoint;
  /** 用户输入的已知实际距离数值 */
  knownDistance: number;
  /** 输入数值的单位 */
  unit: DistanceUnit;
  /** 已知距离换算成米 */
  knownDistanceMeters: number;
  /** 两点之间的像素距离 */
  pixelDistance: number;
  /** 每像素代表的米数 */
  metersPerPixel: number;
  /** 校准时间，便于展示与排查 */
  calibratedAt: string;
}

export type ScaleValidationResult =
  | { ok: true; scale: MapScale }
  | { ok: false; error: string };

/** 两点欧氏距离（像素） */
export function pixelDistanceBetween(a: ScalePoint, b: ScalePoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 校准点到地图范围校验 */
function isPointInImage(p: ScalePoint, width: number, height: number): boolean {
  return (
    Number.isFinite(p.x) &&
    Number.isFinite(p.y) &&
    p.x >= 0 &&
    p.x <= width &&
    p.y >= 0 &&
    p.y <= height
  );
}

/**
 * 校验并生成比例尺校准数据。
 *
 * 失败情形都给出明确中文错误，绝不返回“看起来能用”的伪数据：
 * - 未选择两个点 / 两点重合（像素距离为 0，无法得到系数）
 * - 已知距离不是正数、非数字、超出合理范围
 * - 单位非法
 * - 校准点超出地图范围
 */
export function createMapScale(
  a: ScalePoint | null,
  b: ScalePoint | null,
  knownDistance: number | string,
  unit: string,
  imageWidth: number,
  imageHeight: number,
): ScaleValidationResult {
  if (!a || !b) {
    return { ok: false, error: '请在地图上选择两个校准点' };
  }
  if (!isPointInImage(a, imageWidth, imageHeight) || !isPointInImage(b, imageWidth, imageHeight)) {
    return { ok: false, error: '校准点超出地图范围，请重新选择' };
  }

  const pixelDistance = pixelDistanceBetween(a, b);
  if (pixelDistance < 1e-6) {
    return { ok: false, error: '两个校准点重合，像素距离为 0，无法计算比例尺' };
  }

  const numeric =
    typeof knownDistance === 'number' ? knownDistance : Number(String(knownDistance).trim());
  if (String(knownDistance).trim() === '' || !Number.isFinite(numeric)) {
    return { ok: false, error: '请输入有效的实际距离（数字）' };
  }
  if (numeric <= 0) {
    return { ok: false, error: '实际距离必须大于 0' };
  }
  if (numeric > 100_000) {
    return { ok: false, error: '实际距离过大（超过 100000），请检查数值与单位' };
  }

  if (unit !== 'm' && unit !== 'km') {
    return { ok: false, error: '请选择距离单位（米或千米）' };
  }
  const typedUnit: DistanceUnit = unit;

  const knownDistanceMeters = numeric * UNIT_TO_METERS[typedUnit];
  const metersPerPixel = knownDistanceMeters / pixelDistance;
  if (!Number.isFinite(metersPerPixel) || metersPerPixel <= 0) {
    return { ok: false, error: '比例尺计算结果无效，请检查输入' };
  }

  return {
    ok: true,
    scale: {
      a: { x: a.x, y: a.y },
      b: { x: b.x, y: b.y },
      knownDistance: numeric,
      unit: typedUnit,
      knownDistanceMeters,
      pixelDistance,
      metersPerPixel,
      calibratedAt: new Date().toISOString(),
    },
  };
}

/**
 * 距离格式化：自动选择米 / 千米，并合理控制小数位。
 *
 * - < 1000 米：保留 1 位小数，单位“米”
 * - >= 1000 米：换算为千米，保留 2 位小数
 * - 非有限值：直接返回提示，避免显示 NaN
 */
export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters)) return '—';
  const abs = Math.abs(meters);
  if (abs >= 1000) {
    return `${(meters / 1000).toFixed(2)} 千米`;
  }
  return `${meters.toFixed(1)} 米`;
}

/** 像素长度 → 实际米数；未校准时返回 null（绝不把像素冒充为米） */
export function pixelsToMeters(pixelLength: number, scale: MapScale | null): number | null {
  if (!scale) return null;
  if (!Number.isFinite(pixelLength)) return null;
  if (!Number.isFinite(scale.metersPerPixel) || scale.metersPerPixel <= 0) return null;
  return pixelLength * scale.metersPerPixel;
}

/** 描述比例尺，用于界面展示 */
export function describeScale(scale: MapScale): string {
  return `1 像素 ≈ ${scale.metersPerPixel.toFixed(4)} 米`;
}
