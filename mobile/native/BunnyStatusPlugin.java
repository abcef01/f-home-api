package app.bunnyhome.companion;

import android.app.AppOpsManager;
import android.app.KeyguardManager;
import android.app.usage.UsageStats;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Process;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.List;

/**
 * 把浏览器拿不到的两件事交给系统：
 *   · 有没有锁屏   —— KeyguardManager.isKeyguardLocked()
 *   · 正在用哪个 App —— UsageStatsManager 最近一次前台应用
 *
 * 「正在用哪个 App」需要用户手动授权「使用情况访问」，
 * 系统设置里那一项叫「有权查看使用情况的应用」。
 * 没有授权时返回 null，不报错、不崩溃。
 */
@CapacitorPlugin(name = "BunnyStatus")
public class BunnyStatusPlugin extends Plugin {

    @PluginMethod
    public void getStatus(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("locked", isLocked());
        ret.put("foregroundApp", foregroundAppName());
        ret.put("usageAccess", hasUsageAccess());
        call.resolve(ret);
    }

    /** 跳到系统的「使用情况访问」授权页 */
    @PluginMethod
    public void openUsageAccess(PluginCall call) {
        try {
            android.content.Intent i = new android.content.Intent(android.provider.Settings.ACTION_USAGE_ACCESS_SETTINGS);
            i.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("打不开设置页：" + e.getMessage());
        }
    }

    private boolean isLocked() {
        KeyguardManager km = (KeyguardManager) getContext().getSystemService(Context.KEYGUARD_SERVICE);
        return km != null && km.isKeyguardLocked();
    }

    private boolean hasUsageAccess() {
        try {
            AppOpsManager ops = (AppOpsManager) getContext().getSystemService(Context.APP_OPS_SERVICE);
            int mode = Build.VERSION.SDK_INT >= 29
                ? ops.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), getContext().getPackageName())
                : ops.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), getContext().getPackageName());
            return mode == AppOpsManager.MODE_ALLOWED;
        } catch (Exception e) {
            return false;
        }
    }

    private String foregroundAppName() {
        if (!hasUsageAccess()) return null;
        try {
            UsageStatsManager usm = (UsageStatsManager) getContext().getSystemService(Context.USAGE_STATS_SERVICE);
            long now = System.currentTimeMillis();
            List<UsageStats> list = usm.queryUsageStats(UsageStatsManager.INTERVAL_DAILY, now - 60_000, now);
            if (list == null || list.isEmpty()) return null;

            UsageStats latest = null;
            for (UsageStats s : list) {
                if (latest == null || s.getLastTimeUsed() > latest.getLastTimeUsed()) latest = s;
            }
            if (latest == null) return null;

            String pkg = latest.getPackageName();
            PackageManager pm = getContext().getPackageManager();
            try {
                ApplicationInfo info = pm.getApplicationInfo(pkg, 0);
                CharSequence label = pm.getApplicationLabel(info);
                return label != null ? label.toString() : pkg;
            } catch (Exception e) {
                return pkg;
            }
        } catch (Exception e) {
            return null;
        }
    }
}
