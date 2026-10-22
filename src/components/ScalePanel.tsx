import { useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import {
  DISTANCE_UNIT_LABELS,
  describeScale,
  pixelDistanceBetween,
  type DistanceUnit,
} from '../lib/scale';
import styles from './ScalePanel.module.css';

/**
 * 比例尺校准面板。
 *
 * 流程：在“校准模式”下于地图上点选两点 → 输入这两点的已知实际距离与单位 → 应用校准。
 * 校准点保存的是原始图片像素坐标，与缩放/拖动无关。
 */
export function ScalePanel() {
  const image = useAppStore((s) => s.image);
  const scale = useAppStore((s) => s.scale);
  const scalePointA = useAppStore((s) => s.scalePointA);
  const scalePointB = useAppStore((s) => s.scalePointB);
  const scalePicking = useAppStore((s) => s.scalePicking);
  const scaleNextPoint = useAppStore((s) => s.scaleNextPoint);
  const setScalePicking = useAppStore((s) => s.setScalePicking);
  const setScalePoint = useAppStore((s) => s.setScalePoint);
  const resetScalePoints = useAppStore((s) => s.resetScalePoints);
  const applyScale = useAppStore((s) => s.applyScale);
  const clearScale = useAppStore((s) => s.clearScale);
  const pushNotice = useAppStore((s) => s.pushNotice);

  const [distanceInput, setDistanceInput] = useState('');
  const [unit, setUnit] = useState<DistanceUnit>('m');
  const [error, setError] = useState<string | null>(null);

  const bothPointsReady = Boolean(scalePointA && scalePointB);
  const pixelDistance =
    scalePointA && scalePointB ? pixelDistanceBetween(scalePointA, scalePointB) : null;

  const handleApply = () => {
    setError(null);
    const result = applyScale(distanceInput, unit);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    pushNotice(
      'success',
      `比例尺已校准：1 像素 ≈ ${result.scale.metersPerPixel.toFixed(4)} 米`,
    );
  };

  if (!image) {
    return (
      <section className={styles.panel} aria-labelledby="scale-panel-heading" data-testid="scale-panel">
        <h2 id="scale-panel-heading" className={styles.heading}>比例尺校准</h2>
        <p className={styles.empty}>请先上传底图，再校准比例尺。</p>
      </section>
    );
  }

  return (
    <section className={styles.panel} aria-labelledby="scale-panel-heading" data-testid="scale-panel">
      <div className={styles.headingRow}>
        <h2 id="scale-panel-heading" className={styles.heading}>比例尺校准</h2>
        <span
          className={scale ? styles.statusOk : styles.statusWarn}
          data-testid="scale-status"
          data-calibrated={scale ? 'true' : 'false'}
        >
          {scale ? '已校准' : '未校准'}
        </span>
      </div>

      <p className={styles.desc}>
        在地图上选择两个位置，输入它们之间的已知实际距离，即可把像素长度换算成实际距离。
        <br />
        <strong>注意：</strong>本算法假定图片各方向比例一致。若底图存在透视变形或横纵比例不均匀，
        结果仅为<strong>近似估算</strong>，不具备测绘级精度。
      </p>

      {scale && (
        <div className={styles.currentBox} data-testid="scale-current">
          <div className={styles.currentTitle}>当前比例尺</div>
          <div className={styles.currentMain} data-testid="scale-ratio">
            {describeScale(scale)}
          </div>
          <div className={styles.currentDetail} data-testid="scale-detail">
            校准点 A({scale.a.x}, {scale.a.y}) → B({scale.b.x}, {scale.b.y})，
            像素距离 {scale.pixelDistance.toFixed(2)} px，
            已知距离 {scale.knownDistance} {DISTANCE_UNIT_LABELS[scale.unit]}
          </div>
        </div>
      )}

      {!scale && (
        <p className={styles.warn} data-testid="scale-uncalibrated-warning">
          当前未校准：道路与路线长度只能显示为<strong>像素</strong>，不会显示为米。
        </p>
      )}

      <div className={styles.pickRow}>
        <button
          type="button"
          className={[styles.pickButton, scalePicking ? styles.pickActive : ''].join(' ')}
          onClick={() => setScalePicking(!scalePicking)}
          data-testid="scale-pick-toggle"
        >
          {scalePicking ? '退出地图点选' : '在地图上点选校准点'}
        </button>
        <button
          type="button"
          className={styles.resetButton}
          onClick={() => {
            resetScalePoints();
            setError(null);
          }}
          data-testid="scale-reset-points"
        >
          重置校准点
        </button>
      </div>

      {scalePicking && (
        <p className={styles.pickHint} data-testid="scale-pick-hint">
          请在地图上点击
          <strong>{scaleNextPoint === 'a' ? ' 第 1 个点（A）' : ' 第 2 个点（B）'}</strong>
          ；点击位置会自动换算为原始图片像素坐标。
        </p>
      )}

      <div className={styles.pointsRow}>
        <PointField
          label="校准点 A"
          point={scalePointA}
          testId="scale-point-a"
          onChange={(p) => setScalePoint('a', p)}
        />
        <PointField
          label="校准点 B"
          point={scalePointB}
          testId="scale-point-b"
          onChange={(p) => setScalePoint('b', p)}
        />
      </div>

      {pixelDistance !== null && (
        <p className={styles.pixelInfo} data-testid="scale-pixel-distance">
          两点像素距离：{pixelDistance.toFixed(2)} px
        </p>
      )}

      <div className={styles.inputRow}>
        <label className={styles.field}>
          <span className={styles.label}>实际距离</span>
          <input
            type="number"
            min={0}
            step="any"
            value={distanceInput}
            placeholder="例如 500"
            data-testid="scale-distance-input"
            onChange={(e) => {
              setDistanceInput(e.target.value);
              setError(null);
            }}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>单位</span>
          <select
            value={unit}
            data-testid="scale-unit-select"
            onChange={(e) => {
              setUnit(e.target.value as DistanceUnit);
              setError(null);
            }}
          >
            <option value="m">米</option>
            <option value="km">千米</option>
          </select>
        </label>
        <button
          type="button"
          className={styles.applyButton}
          onClick={handleApply}
          disabled={!bothPointsReady}
          title={bothPointsReady ? '应用当前校准' : '请先在地图上点选两个校准点'}
          data-testid="scale-apply"
        >
          应用校准
        </button>
      </div>

      {error && (
        <p className={styles.error} role="alert" data-testid="scale-error">
          {error}
        </p>
      )}

      {scale && (
        <button
          type="button"
          className={styles.clearButton}
          onClick={() => {
            clearScale();
            setDistanceInput('');
            setError(null);
            pushNotice('info', '已清除比例尺，长度恢复为像素显示');
          }}
          data-testid="scale-clear"
        >
          清除比例尺
        </button>
      )}
    </section>
  );
}

interface PointFieldProps {
  label: string;
  point: { x: number; y: number } | null;
  testId: string;
  onChange: (point: { x: number; y: number } | null) => void;
}

function PointField({ label, point, testId, onChange }: PointFieldProps) {
  return (
    <div className={styles.pointField}>
      <span className={styles.label}>{label}</span>
      <div className={styles.pointValues} data-testid={testId}>
        {point ? (
          <>
            <span data-testid={`${testId}-x`}>X {point.x}</span>
            <span data-testid={`${testId}-y`}>Y {point.y}</span>
            <button type="button" className={styles.clearPoint} onClick={() => onChange(null)}>
              清除
            </button>
          </>
        ) : (
          <span className={styles.pointEmpty}>未选择</span>
        )}
      </div>
    </div>
  );
}
