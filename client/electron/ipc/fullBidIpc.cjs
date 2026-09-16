const { ipcMain } = require('electron');

function registerFullBidIpc({ fullBidMergeService }) {
  ipcMain.handle('full-bid:load', () => fullBidMergeService.load());
  ipcMain.handle('full-bid:export', async (event, { requestId, export_format } = {}) => {
    const progress = (value) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('export:word-progress', { requestId, ...value });
      }
    };
    try {
      return await fullBidMergeService.exportWord({ export_format }, progress);
    } catch (error) {
      progress({ phase: 'error', progress: 100, message: error.message || '完整标书导出失败' });
      throw error;
    }
  });
}

module.exports = { registerFullBidIpc };
