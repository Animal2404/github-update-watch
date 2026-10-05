// 版本号：与 package.json 的 version 保持一致（tools/check-version-sync.mjs 会校验，CI 里会跑）。
// 放在这里是因为三端都要显示它：桌面/网页读得到，安卓 APK 里同一份 public/ 也读得到。
// 改版本号请用：node tools/bump-version.mjs 1.0.2
window.__GUW_VERSION = '1.0.2';
