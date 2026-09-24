import test from 'node:test';
import assert from 'node:assert/strict';

import { deepLinkFeedback } from './deepLinkFeedback.ts';

test('deep link feedback is visible for opened, already-open and blocked navigation', () => {
  assert.deepEqual(deepLinkFeedback('changed', 'bid-generation'), {
    message: '已打开标书生成，可上传招标文件开始新标书',
    type: 'success',
  });
  assert.deepEqual(deepLinkFeedback('unchanged', 'technical-plan'), {
    message: '技术标生成页面已在前台',
    type: 'info',
  });
  assert.deepEqual(deepLinkFeedback('blocked', 'business-bid'), {
    message: '当前页面有未完成操作，请处理后再打开商务标生成',
    type: 'info',
  });
});
