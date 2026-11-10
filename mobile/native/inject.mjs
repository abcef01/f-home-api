/**
 * 把原生插件注入到 `npx cap add android` 生成出来的工程里。
 * 在 CI 里跑：node mobile/native/inject.mjs
 *
 * 做三件事：
 *   1. 复制 BunnyStatusPlugin.java 到 android 工程的包目录
 *   2. 在 MainActivity 里注册插件
 *   3. 在 AndroidManifest.xml 里加权限声明
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('mobile');
const ANDROID = path.join(ROOT, 'android');
const PKG = 'app/bunnyhome/companion';

if (!fs.existsSync(ANDROID)) {
  console.error('找不到 mobile/android，先跑 npx cap add android');
  process.exit(1);
}

/* 1. 插件文件 */
const javaDir = path.join(ANDROID, 'app/src/main/java', PKG);
fs.mkdirSync(javaDir, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'native/BunnyStatusPlugin.java'), path.join(javaDir, 'BunnyStatusPlugin.java'));
console.log('✓ 插件已复制');

/* 2. MainActivity 注册 */
const mainPath = path.join(javaDir, 'MainActivity.java');
if (fs.existsSync(mainPath)) {
  let src = fs.readFileSync(mainPath, 'utf8');
  if (!src.includes('BunnyStatusPlugin')) {
    src = src.replace(
      /public class MainActivity extends BridgeActivity \{/,
      `public class MainActivity extends BridgeActivity {\n  @Override\n  public void onCreate(android.os.Bundle savedInstanceState) {\n    registerPlugin(BunnyStatusPlugin.class);\n    super.onCreate(savedInstanceState);\n  }\n`
    );
    fs.writeFileSync(mainPath, src);
    console.log('✓ MainActivity 已注册插件');
  }
} else {
  console.warn('… 没找到 MainActivity.java，跳过注册');
}

/* 3. 权限 */
const manifestPath = path.join(ANDROID, 'app/src/main/AndroidManifest.xml');
if (fs.existsSync(manifestPath)) {
  let xml = fs.readFileSync(manifestPath, 'utf8');
  const perms = ['android.permission.PACKAGE_USAGE_STATS', 'android.permission.QUERY_ALL_PACKAGES'];
  let added = 0;
  for (const p of perms) {
    if (!xml.includes(p)) {
      xml = xml.replace(/<application/, `<uses-permission android:name="${p}" tools:ignore="ProtectedPermissions" />\n    <application`);
      added += 1;
    }
  }
  if (added && !xml.includes('xmlns:tools')) {
    xml = xml.replace('<manifest', '<manifest xmlns:tools="http://schemas.android.com/tools"');
  }
  fs.writeFileSync(manifestPath, xml);
  console.log(`✓ 权限已写入（新增 ${added} 条）`);
}
