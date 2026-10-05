/** 跨平台找 Chrome/Edge，并给出无头启动参数（CI 上是 Linux + root，需要 --no-sandbox）。 */
import fs from 'node:fs';

export function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    // Linux（GitHub Actions ubuntu-latest 自带）
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    // Windows
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

// --no-proxy-server：本机设了系统代理时，浏览器会走代理出去，而未认证的 GitHub 额度
// 是按**出口 IP** 算的——共享代理节点的额度经常已被用光，表现为"明明 curl 直连还有额度，
// 页面却报限流"。测试要的是确定性和与应用一致的行为，所以让测试浏览器直连。
export const HEADLESS_ARGS = ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars', '--no-proxy-server'];
