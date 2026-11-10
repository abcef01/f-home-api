# 打包 APK 时要做的事（清单）

> 这份清单放在仓库里，任何人（包括未来的我）打开仓库都能看到。
> 状态：⬜ 未做 / 🔄 代码已写未验证 / ✅ 已验证

## 0. 前置

- ⬜ 在 GitHub 仓库点 **Actions → build-android → Run workflow**
- ⬜ 下载 artifact 里的 `app-debug.apk`
- ⬜ 手机上允许「安装未知来源应用」，装好

> 第一次云端构建很可能会失败（这台开发机没有 Android SDK，代码没编译过）。
> 把 Actions 的报错贴出来，我照着改。

## 1. 手机状态（已写代码，未验证）

- 🔄 `mobile/native/BunnyStatusPlugin.java`
  - 锁屏：`KeyguardManager`（不需要授权）
  - 正在用的 App：`UsageStatsManager`（需要「使用情况访问」权限）
- ⬜ 装好 App 后，去 **设置 → 应用 → 特殊权限 → 使用情况访问 → 允许 Bunny's Home**
- ⬜ 验证：手机上打开微信，看 App 里 Elliott 是否会知道

## 2. 健康数据（华为手环）

### 前提确认（这一步最不确定）

- ⬜ 打开华为运动健康 → 设置 → 找有没有 **「Health Connect」/「连接其他应用」**
  - 有 → 打开同步，继续往下
  - 没有 → 这个版本不支持，只能继续用「发截图」的方式，或者考虑导出再导入

### 代码（等上面确认通过再写，约半天）

- ⬜ 写 `mobile/native/HealthPlugin.kt`：读昨天步数 / 昨晚睡眠 / 静息心率
- ⬜ `mobile/native/inject.mjs` 里加 `androidx.health.connect:connect-client` 依赖和权限
- ⬜ 装好后在系统里授权 Health Connect 读取权限
- ⬜ 读到的数据走 `/api/device` 上报，同时在聊天提示词里出现

> 为什么先不写：华为这版到底支不支持 Health Connect 还不知道。
> 不支持的话这套代码白写，改成「截图」或「导出再导入」更实际。

### 权限清单（AndroidManifest）

```
android.permission.health.READ_STEPS
android.permission.health.READ_SLEEP
android.permission.health.READ_HEART_RATE
android.permission.health.READ_RESTING_HEART_RATE
```

## 3. 通知

- ⬜ 确认 APK 里 Web Push 仍可用（Capacitor 的 WebView 对 push 支持有限）
  - 如果不行：改用 FCM 原生推送，需要 Firebase 项目 + google-services.json
- ⬜ 验证锁屏上能看到通知正文

## 4. 分发

- ⬜ debug APK 自用没问题；要给第二个人装，建议生成 release 签名版
- ⬜ 包名：`app.bunnyhome.companion`（改了就再也换不回来，想好）

---

## 目前不做的

- **远程锁屏**：误判/断网可能把你自己锁在外面，失败代价太高
- **无障碍截屏**：间谍软件级权限，且和已有的「屏幕共享」重复
- **iOS**：需要 Mac + 开发者账号，暂不考虑
