const fs = require('fs');
const path = require('path');
const { configPath, parseTencentSheetUrl } = require('./tencent_doc_config.cjs');

const input = process.argv[2];
try {
  const resolved = parseTencentSheetUrl(input);
  const temporary = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ tencent_doc: { url: resolved.url } }, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, configPath);
  console.log(JSON.stringify({ configured: true, url: resolved.url, fileId: resolved.fileId, configPath: path.resolve(configPath) }));
} catch (error) {
  console.error(error.message || String(error));
  process.exitCode = 1;
}
