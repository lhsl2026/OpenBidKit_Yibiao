import type { SectionId } from '../shared/types/navigation';
import type { ToastType } from '../shared/ui';

export type NavigationResult = 'changed' | 'unchanged' | 'blocked';

const sectionLabels: Partial<Record<SectionId, string>> = {
  'bid-generation': '标书生成',
  'technical-plan': '技术标生成',
  'business-bid': '商务标生成',
};

export function deepLinkFeedback(result: NavigationResult, section: SectionId): { message: string; type: ToastType } {
  const label = sectionLabels[section] ?? '标书生成';
  if (result === 'changed') {
    return {
      message: section === 'bid-generation' ? '已打开标书生成，可上传招标文件开始新标书' : `已打开${label}`,
      type: 'success',
    };
  }
  if (result === 'unchanged') {
    return { message: `${label}页面已在前台`, type: 'info' };
  }
  return { message: `当前页面有未完成操作，请处理后再打开${label}`, type: 'info' };
}
