#!/usr/bin/env bash
# 安卓 APK 冒烟测试：装上 → 启动 → 等界面 → 截图 → 确认没崩、且前台是我们的 Activity。
#
# 为什么要单独一个脚本：reactivecircus/android-emulator-runner 的 script 是**逐行**丢给
# `sh -c` 执行的，写多行 if/fi 会被拆断（报 "Syntax error: end of file unexpected"）。
# 所以这里的逻辑必须整体跑在一个脚本文件里。
#
#   bash tools/android-smoke.sh <apk 路径>
set -euo pipefail

APK="${1:?用法: android-smoke.sh <apk 路径>}"
PACKAGE="com.guw.watch"

echo "== 安装 $APK =="
adb install -r "$APK"

echo "== 确认包已安装 =="
adb shell pm list packages | grep -q "$PACKAGE"

echo "== 启动 App =="
adb shell am start -W -n "$PACKAGE/.MainActivity"

echo "== 等界面渲染（直连模式要联网拉数据）=="
sleep 20

echo "== 截图 =="
adb shell screencap -p /sdcard/app.png
adb pull /sdcard/app.png app.png

echo "== 前台 Activity =="
adb shell dumpsys activity activities | grep -m1 "mResumedActivity" || true

echo "== logcat（AndroidRuntime 错误）=="
adb logcat -d -s AndroidRuntime:E | tail -40 | tee logcat.txt || true

if grep -q "FATAL EXCEPTION" logcat.txt; then
  echo "::error::App 启动时崩溃了"
  exit 1
fi

if ! adb shell dumpsys activity activities | grep -q "$PACKAGE"; then
  echo "::error::App 没在前台"
  exit 1
fi

# 截图太小通常意味着白屏/没渲染出来
SIZE=$(stat -c%s app.png)
echo "截图大小: $SIZE 字节"
if [ "$SIZE" -lt 5000 ]; then
  echo "::error::截图异常小（${SIZE}B），界面可能没渲染出来"
  exit 1
fi

echo "冒烟通过：安装 / 启动 / 前台 / 无崩溃 / 有渲染"
