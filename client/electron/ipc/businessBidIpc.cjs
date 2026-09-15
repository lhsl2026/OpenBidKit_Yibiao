const { ipcMain, dialog } = require('electron');

function registerBusinessBidIpc({ businessBidStore, taskService, exportService }) {
  ipcMain.handle('business-bid:load', () => businessBidStore.loadBusinessBid());
  ipcMain.handle('business-bid:import', (_event, paths) => businessBidStore.importDocuments(paths));
  ipcMain.handle('business-bid:source', (_event, id) => businessBidStore.readSource(id));
  ipcMain.handle('business-bid:import-evidence', async () => {
    const result = await dialog.showOpenDialog({ title: '导入公司证据库快照（records JSON，原件路径相对于快照）', properties: ['openFile'], filters: [{ name: '公司证据台账', extensions: ['json'] }] });
    return result.canceled ? businessBidStore.loadBusinessBid() : businessBidStore.importEvidenceFile(result.filePaths[0]);
  });
  ipcMain.handle('business-bid:review', (_event, payload) => businessBidStore.saveReview(payload));
  ipcMain.handle('business-bid:import-template', async () => {
    const result = await dialog.showOpenDialog({ title: '导入带填写标记的 Word 模板', properties: ['openFile'], filters: [{ name: 'Word 模板', extensions: ['docx'] }] });
    return result.canceled ? businessBidStore.loadBusinessBid() : businessBidStore.importTemplate(result.filePaths[0]);
  });
  ipcMain.handle('business-bid:clear-template', () => businessBidStore.clearTemplate());
  ipcMain.handle('business-bid:analyze', () => taskService.startBusinessBidAnalysis());
  ipcMain.handle('business-bid:generate', () => businessBidStore.generateDraft());
  ipcMain.handle('business-bid:clear', () => businessBidStore.clear());
  ipcMain.handle('business-bid:export', async (event, { kind, requestId }) => {
    const progress = (value) => { if (!event.sender.isDestroyed()) event.sender.send('export:word-progress', { requestId, ...value }); };
    try { return await exportService.exportWord(businessBidStore.getExportPayload(kind), progress); }
    catch (error) { progress({ phase: 'error', progress: 100, message: error.message }); throw error; }
  });
}
module.exports = { registerBusinessBidIpc };
