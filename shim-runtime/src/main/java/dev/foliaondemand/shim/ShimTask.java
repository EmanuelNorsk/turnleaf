package dev.foliaondemand.shim;

import com.tcoded.folialib.wrapper.task.WrappedTask;
import org.bukkit.plugin.Plugin;
import org.bukkit.scheduler.BukkitTask;

/**
 * Unified task handle: implements the BukkitTask interface plugins expect
 * while wrapping FoliaLib's WrappedTask, with a synthetic task id for the
 * legacy int-based scheduler API.
 */
public final class ShimTask implements BukkitTask {

    private final int id;
    private final Plugin plugin;
    private final WrappedTask task;
    private final boolean sync;

    ShimTask(int id, Plugin plugin, WrappedTask task, boolean sync) {
        this.id = id;
        this.plugin = plugin;
        this.task = task;
        this.sync = sync;
    }

    @Override
    public int getTaskId() {
        return id;
    }

    @Override
    public Plugin getOwner() {
        return plugin;
    }

    @Override
    public boolean isSync() {
        return sync;
    }

    @Override
    public boolean isCancelled() {
        return task.isCancelled();
    }

    @Override
    public void cancel() {
        task.cancel();
        ShimCore.BY_ID.remove(id);
    }
}
