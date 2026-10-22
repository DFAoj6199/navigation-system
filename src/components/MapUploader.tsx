import { useRef, useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { loadImageFile } from '../lib/imageLoader';
import { ACCEPT_ATTR, MAX_IMAGE_BYTES } from '../lib/constants';
import styles from './MapUploader.module.css';

/**
 * 地图上传面板。
 * 底图只来自用户选择的本地文件，不做任何网络请求，也不内置示例地图。
 */
export function MapUploader() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);

  const image = useAppStore((s) => s.image);
  const setImage = useAppStore((s) => s.setImage);
  const clearImage = useAppStore((s) => s.clearImage);
  const nodeCount = useAppStore((s) => s.nodes.length);
  const pushNotice = useAppStore((s) => s.pushNotice);

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setLocalError(null);
    setBusy(true);
    try {
      const loaded = await loadImageFile(file);
      if (image && nodeCount > 0) {
        // 换图会让旧节点坐标失效，这里明确告知并清空，避免错位
        pushNotice('info', `已更换底图，原有 ${nodeCount} 个节点因坐标系变化已被清空`);
      }
      setImage(
        {
          fileName: loaded.fileName,
          width: loaded.width,
          height: loaded.height,
          mimeType: loaded.mimeType,
        },
        loaded.objectUrl,
      );
      pushNotice('success', `地图加载成功：${loaded.fileName}（${loaded.width}×${loaded.height} 原始像素）`);
    } catch (error) {
      const message = error instanceof Error ? error.message : '图片加载失败';
      setLocalError(message);
      pushNotice('error', message);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const onDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    const file = event.dataTransfer.files?.[0];
    void handleFile(file);
  };

  return (
    <section className={styles.panel} aria-labelledby="uploader-heading">
      <h2 id="uploader-heading" className={styles.heading}>地图底图</h2>

      {image ? (
        <div className={styles.info} data-testid="image-info">
          <div className={styles.infoRow}>
            <span className={styles.infoLabel}>文件名</span>
            <span className={styles.infoValue} title={image.fileName}>{image.fileName}</span>
          </div>
          <div className={styles.infoRow}>
            <span className={styles.infoLabel}>原始尺寸</span>
            <span className={styles.infoValue}>{image.width} × {image.height} px</span>
          </div>
          <div className={styles.warn}>
            ⚠️ 更换底图会清空当前所有节点（原点与尺寸可能不同）。
          </div>
        </div>
      ) : (
        <div
          className={[styles.dropzone, dragActive ? styles.dropzoneActive : ''].join(' ')}
          onDragOver={(e) => {
            e.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={onDrop}
          data-testid="dropzone"
        >
          <p className={styles.dropText}>把地图图片拖到这里，或</p>
          <button
            type="button"
            className={styles.primaryButton}
            onClick={() => inputRef.current?.click()}
            disabled={busy}
          >
            {busy ? '正在读取…' : '选择本地地图图片'}
          </button>
          <p className={styles.dropHint}>
            支持 PNG / JPG / WEBP / GIF / BMP / AVIF，单个文件 ≤ {MAX_IMAGE_BYTES / 1024 / 1024}MB
            <br />
            底图仅在你本机浏览器内读取，不会上传到任何服务器。
          </p>
        </div>
      )}

      {image && (
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={() => inputRef.current?.click()}
          disabled={busy}
        >
          {busy ? '正在读取…' : '重新选择底图'}
        </button>
      )}
      {image && (
        <button
          type="button"
          className={styles.dangerLink}
          onClick={() => {
            if (nodeCount > 0 && !window.confirm(`确定要移除底图并清空 ${nodeCount} 个节点吗？`)) return;
            clearImage();
            pushNotice('info', '已移除底图');
          }}
        >
          移除底图
        </button>
      )}

      {localError && (
        <p className={styles.errorText} role="alert" data-testid="upload-error">
          {localError}
        </p>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_ATTR}
        className={styles.hiddenInput}
        data-testid="file-input"
        onChange={(e) => void handleFile(e.target.files?.[0])}
      />
    </section>
  );
}
