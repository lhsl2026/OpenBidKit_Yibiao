const path = require('node:path');

function safeArtifactName(value) {
  return String(value || '投标文件').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 80) || '投标文件';
}

function draftArtifactFileName(projectTitle, documentVersion) {
  const version = String(documentVersion ?? '1').replace(/^v/i, '') || '1';
  return `${safeArtifactName(projectTitle)}－技术标初稿－v${safeArtifactName(version)}.docx`;
}

function draftArtifactPath(directory, projectTitle, documentVersion) {
  return path.join(directory, draftArtifactFileName(projectTitle, documentVersion));
}

module.exports = { safeArtifactName, draftArtifactFileName, draftArtifactPath };
