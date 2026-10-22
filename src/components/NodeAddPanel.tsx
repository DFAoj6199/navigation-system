import { useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { parseCoordinateInput, validateNodePoint } from '../lib/nodes';
import styles from './NodeAddPanel.module.css';

/**
 * 手动添加节点面板。
 * 输入坐标系：原始图片左上角为原点，向右为 X 正方向、向下为 Y 正方向。
 * 超出图片范围时阻止提交并给出明确提示。
 */
export function NodeAddPanel() {
  const image = useAppStore((s) => s.image);
  const imageWidth = useAppStore((s) => s.imageWidth);
  const imageHeight = useAppStore((s) => s.imageHeight);
  const addNodeAtPixel = useAppStore((s) => s.addNodeAtPixel);
  const pushNotice = useAppStore((s) => s.pushNotice);

  const [xText, setXText] = useState('');
  const [yText, setYText] = useState('');
  const [nameText, setNameText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);

  const disabled = !image;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    if (!image) {
      setError('请先上传地图图片');
      return;
    }

    const parsedX = parseCoordinateInput(xText, 'X');
    if (!parsedX.ok) {
      setError(parsedX.error);
      return;
    }
    const parsedY = parseCoordinateInput(yText, 'Y');
    if (!parsedY.ok) {
      setError(parsedY.error);
      return;
    }

    const check = validateNodePoint(parsedX.value, parsedY.value, imageWidth, imageHeight);
    if (!check.ok) {
      setError(check.error);
      return;
    }

    const result = addNodeAtPixel(
      check.point.x,
      check.point.y,
      nameText.trim() ? nameText.trim() : undefined,
    );
    if (!result.ok) {
      setError(result.error ?? '添加节点失败');
      return;
    }

    pushNotice('success', `已添加节点“${result.node?.name}”，像素坐标 (${check.point.x}, ${check.point.y})`);
    setXText('');
    setYText('');
    setNameText('');
  };

  return (
    <section className={styles.panel} aria-labelledby="add-node-heading">
      <h2 id="add-node-heading" className={styles.heading}>手动添加节点</h2>
      <p className={styles.desc}>
        坐标以原始图片<strong>左上角为原点</strong>，X 向右、Y 向下，单位为原始像素。
        {image && (
          <>
            <br />
            当前有效范围：X 0 ~ {imageWidth}，Y 0 ~ {imageHeight}
          </>
        )}
      </p>

      <form onSubmit={submit} className={styles.form} noValidate>
        <div className={styles.coordRow}>
          <label className={styles.field}>
            <span className={styles.label}>X</span>
            <input
              type="text"
              inputMode="decimal"
              value={xText}
              disabled={disabled}
              placeholder="X 像素"
              data-testid="input-x"
              onChange={(e) => {
                setXText(e.target.value);
                setError(null);
              }}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Y</span>
            <input
              type="text"
              inputMode="decimal"
              value={yText}
              disabled={disabled}
              placeholder="Y 像素"
              data-testid="input-y"
              onChange={(e) => {
                setYText(e.target.value);
                setError(null);
              }}
            />
          </label>
        </div>

        <label className={styles.field}>
          <span className={styles.label}>名称（可选）</span>
          <input
            type="text"
            value={nameText}
            disabled={disabled}
            placeholder="留空则自动命名"
            maxLength={40}
            data-testid="input-name"
            onChange={(e) => {
              setNameText(e.target.value);
              setNameError(null);
            }}
          />
        </label>

        {nameError && <p className={styles.error} role="alert">{nameError}</p>}
        {error && (
          <p className={styles.error} role="alert" data-testid="add-node-error">
            {error}
          </p>
        )}

        <button type="submit" className={styles.button} disabled={disabled} data-testid="add-node-submit">
          按坐标添加节点
        </button>
        {disabled && <p className={styles.hint}>上传底图后才能添加节点。</p>}
      </form>
    </section>
  );
}
