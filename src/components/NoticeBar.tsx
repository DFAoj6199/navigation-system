import { useAppStore } from '../store/useAppStore';
import styles from './NoticeBar.module.css';

/** 全局提示条：成功/信息自动消失，错误需手动关闭 */
export function NoticeBar() {
  const notices = useAppStore((s) => s.notices);
  const dismissNotice = useAppStore((s) => s.dismissNotice);

  if (notices.length === 0) return null;

  return (
    <div className={styles.stack} role="status" aria-live="polite" data-testid="notice-stack">
      {notices.map((notice) => (
        <div
          key={notice.id}
          className={[styles.notice, styles[notice.kind]].join(' ')}
          data-testid={`notice-${notice.kind}`}
        >
          <span className={styles.text}>{notice.text}</span>
          <button
            type="button"
            className={styles.close}
            aria-label="关闭提示"
            onClick={() => dismissNotice(notice.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
