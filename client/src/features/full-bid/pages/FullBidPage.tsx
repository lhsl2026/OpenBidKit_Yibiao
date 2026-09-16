import { useCallback, useEffect, useRef, useState } from 'react';
import type { SectionId } from '../../../shared/types/navigation';
import type { ExportFormatConfig } from '../../../shared/types/exportFormat';
import { DEFAULT_EXPORT_FORMAT } from '../../../shared/types/exportFormat';
import { useToast } from '../../../shared/ui';
import type { FullBidStatus, FullBidVolumeStatus } from '../types';

interface FullBidPageProps {
  onSectionChange: (section: SectionId) => void;
}

const relevantTasks = new Set([
  'business-bid-generation',
  'content-generation',
]);

function statusClass(status: FullBidVolumeStatus) {
  return `is-${status}`;
}

function FullBidPage({ onSectionChange }: FullBidPageProps) {
  const { showToast } = useToast();
  const [status, setStatus] = useState<FullBidStatus | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormatConfig>(DEFAULT_EXPORT_FORMAT);
  const [exportMessage, setExportMessage] = useState('');
  const [exportPath, setExportPath] = useState('');
  const requestIdRef = useRef('');

  const load = useCallback(async () => {
    if (!window.yibiao?.fullBid) {
      setLoadError('完整标书桌面服务未就绪，请在易标桌面客户端打开。');
      return;
    }
    try {
      const next = await window.yibiao.fullBid.load();
      setStatus(next);
      setLoadError('');
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void load();
    window.yibiao?.config.load().then((config) => {
      if (config?.export_format) setExportFormat(config.export_format);
    }).catch(() => {});
    const offTask = window.yibiao?.tasks.onTaskEvent((event) => {
      if (relevantTasks.has(event.task.type) && ['success', 'error'].includes(event.task.status)) void load();
    }) || (() => {});
    const offExport = window.yibiao?.export.onWordExportProgress((event) => {
      if (event.requestId === requestIdRef.current) setExportMessage(`${event.progress}% · ${event.message}`);
    }) || (() => {});
    return () => { offTask(); offExport(); };
  }, [load]);

  const exportFullBid = async () => {
    if (!window.yibiao?.fullBid) return;
    setBusy(true);
    setExportPath('');
    requestIdRef.current = crypto.randomUUID();
    setExportMessage('正在重新校验两个分册');
    try {
      const result = await window.yibiao.fullBid.export({ requestId: requestIdRef.current, export_format: exportFormat });
      if (result.success && result.path) {
        setExportPath(result.path);
        showToast(result.message || '完整标书已导出', 'success');
      }
      await load();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showToast(message, 'error');
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (!status) {
    return <div className="full-bid-page"><section className="panel full-bid-loading"><h2>完整标书</h2><p>{loadError || '正在检查技术标与商务标…'}</p></section></div>;
  }

  return (
    <div className="full-bid-page">
      <header className="full-bid-header">
        <div>
          <span className="section-kicker">完整标书 · 自动组卷</span>
          <h2>合并商务标与技术标</h2>
          <p>统一校验项目和公司主体，一次生成含封面、目录及交付检查的完整投标文件。</p>
        </div>
        <button type="button" className="text-button" disabled={busy} onClick={() => void load()}>刷新状态</button>
      </header>

      <section className="full-bid-summary panel" aria-label="合并项目摘要">
        <div><span>项目名称</span><strong>{status.projectName || '尚未填写'}</strong></div>
        <div><span>公司主体</span><strong>{status.companyName || '尚未选择'}</strong></div>
        <div><span>导出格式</span><strong>当前模版设置</strong></div>
      </section>

      <section className="full-bid-volumes" aria-label="分册生成状态">
        <article className={`panel full-bid-volume ${statusClass(status.business.status)}`}>
          <div className="full-bid-volume-head"><span>第一部分</span><strong>{status.business.label}</strong></div>
          <h3>商务标</h3>
          <p>{status.businessProjectName || '未填写项目名称'} · {status.business.sectionCount} 个章节</p>
          <button type="button" className="secondary-action" disabled={busy} onClick={() => onSectionChange('business-bid')}>打开商务标</button>
        </article>
        <article className={`panel full-bid-volume ${statusClass(status.technical.status)}`}>
          <div className="full-bid-volume-head"><span>第二部分</span><strong>{status.technical.label}</strong></div>
          <h3>技术标</h3>
          <p>{status.technicalProjectName || '未填写项目名称'} · {status.technical.sectionCount} 个章节</p>
          <button type="button" className="secondary-action" disabled={busy} onClick={() => onSectionChange('technical-plan')}>打开技术标</button>
        </article>
      </section>

      <section className="panel full-bid-order" aria-label="完整标书组卷顺序">
        <div>
          <span className="section-kicker">组卷顺序</span>
          <h3>封面与目录之后依次装入</h3>
        </div>
        <ol>{status.mergeOrder.map((item) => <li key={item}>{item}</li>)}</ol>
        <p>合并生成新文件，不会修改技术标、商务标工作区或已经导出的分册。</p>
      </section>

      {!status.canExport && <p className="full-bid-blocker" role="alert">{status.blockingMessage}</p>}

      <section className="panel full-bid-export">
        <div>
          <h3>导出完整投标文件</h3>
          <p>导出前会再次校验两个分册，Word 目录首次打开时可右键更新页码。</p>
          {exportMessage && <small>{exportMessage}</small>}
          {exportPath && <small className="full-bid-path">{exportPath}</small>}
        </div>
        <div className="full-bid-actions">
          {exportPath && <button type="button" className="secondary-action" onClick={() => void window.yibiao.export.openFile(exportPath)}>打开文件</button>}
          <button type="button" className="primary-action" disabled={busy || !status.canExport} onClick={() => void exportFullBid()}>{busy ? '正在生成…' : '生成完整标书 DOCX'}</button>
        </div>
      </section>
    </div>
  );
}

export default FullBidPage;
