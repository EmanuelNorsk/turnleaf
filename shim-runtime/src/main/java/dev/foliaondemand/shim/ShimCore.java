package dev.foliaondemand.shim;

import com.tcoded.folialib.FoliaLib;
import com.tcoded.folialib.impl.PlatformScheduler;
import com.tcoded.folialib.wrapper.task.WrappedTask;
import org.bukkit.plugin.Plugin;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.scheduler.BukkitRunnable;
import org.bukkit.scheduler.BukkitTask;

import java.util.Collections;
import java.util.Map;
import java.util.WeakHashMap;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;

/**
 * Internals behind {@link Shim}: per-plugin FoliaLib instances, the synthetic
 * task-id registry (for the int-based legacy scheduler API), and the
 * BukkitRunnable registry (so cancel()/getTaskId() keep working after their
 * call sites are redirected).
 */
final class ShimCore {

    static final boolean FOLIA = detectFolia();

    private static final Map<Plugin, FoliaLib> LIBS = new ConcurrentHashMap<>();

    // Last real server tick we observed on a region thread, plus when — lets us
    // approximate the tick number when Bukkit.getCurrentTick() would throw
    // "No currently ticking region" (e.g. called from an async event thread).
    private static volatile int lastTick = 0;
    private static volatile long lastTickNanos = System.nanoTime();

    static int syncTick(int realTick) {
        lastTick = realTick;
        lastTickNanos = System.nanoTime();
        return realTick;
    }

    static int approxTick() {
        long elapsedNanos = System.nanoTime() - lastTickNanos;
        return lastTick + (int) (elapsedNanos / 50_000_000L); // 20 ticks/s → 50ms each
    }

    static final AtomicInteger NEXT_ID = new AtomicInteger(1);
    static final ConcurrentMap<Integer, ShimTask> BY_ID = new ConcurrentHashMap<>();
    /** Weak keys: entries vanish with their runnables, so cancelled tasks don't pile up. */
    static final Map<BukkitRunnable, ShimTask> BY_RUNNABLE = Collections.synchronizedMap(new WeakHashMap<>());

    static PlatformScheduler scheduler(Plugin plugin) {
        return LIBS.computeIfAbsent(plugin, FoliaLib::new).getScheduler();
    }

    // The converted plugin owns this (relocated) shim class, so its classloader
    // resolves back to the plugin — used by entity-mutation shims that have no
    // Plugin argument to thread through.
    private static volatile Plugin owningPlugin;

    static Plugin owningPlugin() {
        Plugin p = owningPlugin;
        if (p == null) {
            p = JavaPlugin.getProvidingPlugin(ShimCore.class);
            owningPlugin = p;
        }
        return p;
    }

    static PlatformScheduler ownScheduler() {
        return scheduler(owningPlugin());
    }

    /** Single execution; the registry entry is removed once the task has run. */
    static ShimTask oneShot(Plugin plugin, Runnable task, long delayTicks, boolean async) {
        int id = NEXT_ID.getAndIncrement();
        AtomicBoolean done = new AtomicBoolean();
        Runnable wrapped = () -> {
            try {
                task.run();
            } finally {
                done.set(true);
                BY_ID.remove(id);
            }
        };
        long delay = Math.max(1L, delayTicks);
        WrappedTask wt = async
                ? scheduler(plugin).runLaterAsync(wrapped, delay)
                : scheduler(plugin).runLater(wrapped, delay);
        ShimTask shimTask = new ShimTask(id, plugin, wt, !async);
        BY_ID.put(id, shimTask);
        if (done.get()) {
            BY_ID.remove(id); // task already ran before registration
        }
        return shimTask;
    }

    /** Repeating task; stays registered until cancelled. */
    static ShimTask timer(Plugin plugin, Runnable task, long delayTicks, long periodTicks, boolean async) {
        int id = NEXT_ID.getAndIncrement();
        long delay = Math.max(1L, delayTicks);
        long period = Math.max(1L, periodTicks);
        WrappedTask wt = async
                ? scheduler(plugin).runTimerAsync(task, delay, period)
                : scheduler(plugin).runTimer(task, delay, period);
        ShimTask shimTask = new ShimTask(id, plugin, wt, !async);
        BY_ID.put(id, shimTask);
        return shimTask;
    }

    /** Bukkit's Consumer-of-BukkitTask single-shot variants (void return). */
    static void consumerOneShot(Plugin plugin, Consumer<? super BukkitTask> consumer, long delayTicks, boolean async) {
        int id = NEXT_ID.getAndIncrement();
        long delay = Math.max(1L, delayTicks);
        Consumer<WrappedTask> wrapped = wt -> {
            ShimTask shimTask = new ShimTask(id, plugin, wt, !async);
            try {
                consumer.accept(shimTask);
            } finally {
                BY_ID.remove(id);
            }
        };
        if (async) {
            scheduler(plugin).runLaterAsync(wrapped, delay);
        } else {
            scheduler(plugin).runLater(wrapped, delay);
        }
    }

    /** Bukkit's Consumer-of-BukkitTask timer variants (void return). */
    static void consumerTimer(Plugin plugin, Consumer<? super BukkitTask> consumer, long delayTicks, long periodTicks,
                              boolean async) {
        int id = NEXT_ID.getAndIncrement();
        long delay = Math.max(1L, delayTicks);
        long period = Math.max(1L, periodTicks);
        AtomicReference<ShimTask> handle = new AtomicReference<>();
        Consumer<WrappedTask> wrapped = wt -> {
            ShimTask shimTask = handle.updateAndGet(prev -> prev != null ? prev : new ShimTask(id, plugin, wt, !async));
            BY_ID.putIfAbsent(id, shimTask);
            consumer.accept(shimTask);
        };
        if (async) {
            scheduler(plugin).runTimerAsync(wrapped, delay, period);
        } else {
            scheduler(plugin).runTimer(wrapped, delay, period);
        }
    }

    /** BukkitRunnable one-shot: also tracked by runnable identity for cancel()/getTaskId(). */
    static ShimTask runnableOneShot(BukkitRunnable runnable, Plugin plugin, long delayTicks, boolean async) {
        int id = NEXT_ID.getAndIncrement();
        AtomicBoolean done = new AtomicBoolean();
        Runnable wrapped = () -> {
            try {
                runnable.run();
            } finally {
                done.set(true);
                BY_ID.remove(id);
            }
        };
        long delay = Math.max(1L, delayTicks);
        WrappedTask wt = async
                ? scheduler(plugin).runLaterAsync(wrapped, delay)
                : scheduler(plugin).runLater(wrapped, delay);
        ShimTask shimTask = new ShimTask(id, plugin, wt, !async);
        BY_ID.put(id, shimTask);
        BY_RUNNABLE.put(runnable, shimTask);
        if (done.get()) {
            BY_ID.remove(id);
        }
        return shimTask;
    }

    static ShimTask runnableTimer(BukkitRunnable runnable, Plugin plugin, long delayTicks, long periodTicks,
                                  boolean async) {
        ShimTask shimTask = timer(plugin, runnable, delayTicks, periodTicks, async);
        BY_RUNNABLE.put(runnable, shimTask);
        return shimTask;
    }

    private static boolean detectFolia() {
        try {
            Class.forName("io.papermc.paper.threadedregions.RegionizedServer");
            return true;
        } catch (ClassNotFoundException e) {
            return false;
        }
    }

    private ShimCore() {
    }
}
