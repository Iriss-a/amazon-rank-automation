// Loads the per-user Tencent Docs token without ever printing its value.
// setup-token.ps1 writes the token once to HKCU\Environment; fresh processes
// do not inherit that value until Windows restarts, so read that setting too.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const NAME = 'TENCENT_DOCS_TOKEN';
const tokenFile = path.join(__dirname, '.tencent-docs-token');

function userEnvironmentValue() {
  try {
    const output = execFileSync('reg.exe', ['query', 'HKCU\\Environment', '/v', NAME], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    });
    const match = output.match(new RegExp(`^\\s*${NAME}\\s+REG_\\w+\\s+(.+?)\\s*$`, 'mi'));
    return match?.[1]?.trim() || '';
  } catch { return ''; }
}

function localFileValue() {
  try {
    return fs.readFileSync(tokenFile, 'utf8').trim();
  } catch { return ''; }
}

function persistToken() {
  fs.writeFileSync(tokenFile, process.env[NAME], { encoding: 'utf8', mode: 0o600 });
}

function loadTencentDocsToken() {
  const fromEnvironment = String(process.env[NAME] || userEnvironmentValue()).trim();
  const token = fromEnvironment || localFileValue();
  if (!token) throw new Error(`${NAME}_MISSING: authorize once with setup-token.ps1; no token is stored locally`);
  process.env[NAME] = token;
  if (fromEnvironment) persistToken();
  return token;
}

module.exports = { loadTencentDocsToken };
