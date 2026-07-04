package dev.foliaondemand.shim;

import org.bukkit.Location;
import org.bukkit.Server;
import org.bukkit.block.BlockState;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Damageable;
import org.bukkit.entity.Entity;
import org.bukkit.entity.ExperienceOrb;
import org.bukkit.entity.FishHook;
import org.bukkit.entity.HumanEntity;
import org.bukkit.entity.LivingEntity;
import org.bukkit.event.player.PlayerTeleportEvent;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.InventoryHolder;
import org.bukkit.inventory.InventoryView;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.Merchant;
import org.bukkit.plugin.Plugin;
import org.bukkit.potion.PotionEffect;
import org.bukkit.potion.PotionEffectType;
import org.bukkit.scheduler.BukkitRunnable;
import org.bukkit.scheduler.BukkitScheduler;
import org.bukkit.scheduler.BukkitTask;
import org.bukkit.util.Vector;

import java.util.Collection;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Future;
import java.util.function.Consumer;

/**
 * Static redirect targets for the Tier 1 bytecode rewrite.
 *
 * CONTRACT (the TypeScript side derives the rewrite table from this class):
 * every public static method mirrors an original instance method with the
 * receiver prepended as the first parameter — same name, same remaining
 * parameters, same return type. The first parameter's type decides which call
 * sites are redirected:
 *   - BukkitScheduler  → exact-owner match
 *   - BukkitRunnable   → owner match incl. the plugin's own subclasses
 *   - Entity           → any owner under org/bukkit/entity/
 * Do not add public static helpers here that are not redirect targets.
 */
@SuppressWarnings("unused")
public final class Shim {

    // ===== BukkitScheduler: Runnable variants =====

    public static BukkitTask runTask(BukkitScheduler s, Plugin plugin, Runnable task) {
        return ShimCore.oneShot(plugin, task, 1L, false);
    }

    public static BukkitTask runTaskAsynchronously(BukkitScheduler s, Plugin plugin, Runnable task) {
        return ShimCore.oneShot(plugin, task, 1L, true);
    }

    public static BukkitTask runTaskLater(BukkitScheduler s, Plugin plugin, Runnable task, long delay) {
        return ShimCore.oneShot(plugin, task, delay, false);
    }

    public static BukkitTask runTaskLaterAsynchronously(BukkitScheduler s, Plugin plugin, Runnable task, long delay) {
        return ShimCore.oneShot(plugin, task, delay, true);
    }

    public static BukkitTask runTaskTimer(BukkitScheduler s, Plugin plugin, Runnable task, long delay, long period) {
        return ShimCore.timer(plugin, task, delay, period, false);
    }

    public static BukkitTask runTaskTimerAsynchronously(BukkitScheduler s, Plugin plugin, Runnable task, long delay,
                                                        long period) {
        return ShimCore.timer(plugin, task, delay, period, true);
    }

    // ===== BukkitScheduler: Consumer variants (void returns in the Bukkit API) =====

    public static void runTask(BukkitScheduler s, Plugin plugin, Consumer<? super BukkitTask> task) {
        ShimCore.consumerOneShot(plugin, task, 1L, false);
    }

    public static void runTaskAsynchronously(BukkitScheduler s, Plugin plugin, Consumer<? super BukkitTask> task) {
        ShimCore.consumerOneShot(plugin, task, 1L, true);
    }

    public static void runTaskLater(BukkitScheduler s, Plugin plugin, Consumer<? super BukkitTask> task, long delay) {
        ShimCore.consumerOneShot(plugin, task, delay, false);
    }

    public static void runTaskLaterAsynchronously(BukkitScheduler s, Plugin plugin,
                                                  Consumer<? super BukkitTask> task, long delay) {
        ShimCore.consumerOneShot(plugin, task, delay, true);
    }

    public static void runTaskTimer(BukkitScheduler s, Plugin plugin, Consumer<? super BukkitTask> task, long delay,
                                    long period) {
        ShimCore.consumerTimer(plugin, task, delay, period, false);
    }

    public static void runTaskTimerAsynchronously(BukkitScheduler s, Plugin plugin,
                                                  Consumer<? super BukkitTask> task, long delay, long period) {
        ShimCore.consumerTimer(plugin, task, delay, period, true);
    }

    // ===== BukkitScheduler: legacy int-id API =====

    public static int scheduleSyncDelayedTask(BukkitScheduler s, Plugin plugin, Runnable task) {
        return ShimCore.oneShot(plugin, task, 1L, false).getTaskId();
    }

    public static int scheduleSyncDelayedTask(BukkitScheduler s, Plugin plugin, Runnable task, long delay) {
        return ShimCore.oneShot(plugin, task, delay, false).getTaskId();
    }

    public static int scheduleSyncRepeatingTask(BukkitScheduler s, Plugin plugin, Runnable task, long delay,
                                                long period) {
        return ShimCore.timer(plugin, task, delay, period, false).getTaskId();
    }

    public static int scheduleAsyncDelayedTask(BukkitScheduler s, Plugin plugin, Runnable task) {
        return ShimCore.oneShot(plugin, task, 1L, true).getTaskId();
    }

    public static int scheduleAsyncDelayedTask(BukkitScheduler s, Plugin plugin, Runnable task, long delay) {
        return ShimCore.oneShot(plugin, task, delay, true).getTaskId();
    }

    public static int scheduleAsyncRepeatingTask(BukkitScheduler s, Plugin plugin, Runnable task, long delay,
                                                 long period) {
        return ShimCore.timer(plugin, task, delay, period, true).getTaskId();
    }

    public static <T> Future<T> callSyncMethod(BukkitScheduler s, Plugin plugin, Callable<T> task) {
        CompletableFuture<T> future = new CompletableFuture<>();
        ShimCore.scheduler(plugin).runNextTick(wt -> {
            try {
                future.complete(task.call());
            } catch (Throwable t) {
                future.completeExceptionally(t);
            }
        });
        return future;
    }

    public static void cancelTask(BukkitScheduler s, int taskId) {
        ShimTask task = ShimCore.BY_ID.remove(taskId);
        if (task != null) {
            task.cancel();
        }
    }

    public static void cancelTasks(BukkitScheduler s, Plugin plugin) {
        ShimCore.scheduler(plugin).cancelAllTasks();
        ShimCore.BY_ID.values().removeIf(t -> t.getOwner() == plugin);
        synchronized (ShimCore.BY_RUNNABLE) {
            ShimCore.BY_RUNNABLE.values().removeIf(t -> t.getOwner() == plugin);
        }
    }

    /** Approximation: we cannot distinguish "running right now" from "scheduled". */
    public static boolean isCurrentlyRunning(BukkitScheduler s, int taskId) {
        ShimTask task = ShimCore.BY_ID.get(taskId);
        return task != null && !task.isCancelled();
    }

    public static boolean isQueued(BukkitScheduler s, int taskId) {
        ShimTask task = ShimCore.BY_ID.get(taskId);
        return task != null && !task.isCancelled();
    }

    // ===== BukkitRunnable =====

    public static BukkitTask runTask(BukkitRunnable runnable, Plugin plugin) {
        return ShimCore.runnableOneShot(runnable, plugin, 1L, false);
    }

    public static BukkitTask runTaskAsynchronously(BukkitRunnable runnable, Plugin plugin) {
        return ShimCore.runnableOneShot(runnable, plugin, 1L, true);
    }

    public static BukkitTask runTaskLater(BukkitRunnable runnable, Plugin plugin, long delay) {
        return ShimCore.runnableOneShot(runnable, plugin, delay, false);
    }

    public static BukkitTask runTaskLaterAsynchronously(BukkitRunnable runnable, Plugin plugin, long delay) {
        return ShimCore.runnableOneShot(runnable, plugin, delay, true);
    }

    public static BukkitTask runTaskTimer(BukkitRunnable runnable, Plugin plugin, long delay, long period) {
        return ShimCore.runnableTimer(runnable, plugin, delay, period, false);
    }

    public static BukkitTask runTaskTimerAsynchronously(BukkitRunnable runnable, Plugin plugin, long delay,
                                                        long period) {
        return ShimCore.runnableTimer(runnable, plugin, delay, period, true);
    }

    public static void cancel(BukkitRunnable runnable) {
        ShimTask task = ShimCore.BY_RUNNABLE.get(runnable);
        if (task == null) {
            throw new IllegalStateException("Not scheduled yet");
        }
        task.cancel();
    }

    public static int getTaskId(BukkitRunnable runnable) {
        ShimTask task = ShimCore.BY_RUNNABLE.get(runnable);
        if (task == null) {
            throw new IllegalStateException("Not scheduled yet");
        }
        return task.getTaskId();
    }

    public static boolean isCancelled(BukkitRunnable runnable) {
        ShimTask task = ShimCore.BY_RUNNABLE.get(runnable);
        if (task == null) {
            throw new IllegalStateException("Not scheduled yet");
        }
        return task.isCancelled();
    }

    // ===== Entity teleports =====
    // Folia requires teleportAsync; the sync boolean result cannot be awaited
    // without risking a region-thread deadlock, so Tier 1 fires async and
    // returns true optimistically. Flagged as "review" in the report.

    public static boolean teleport(Entity entity, Location location) {
        if (ShimCore.FOLIA) {
            entity.teleportAsync(location);
            return true;
        }
        return entity.teleport(location);
    }

    public static boolean teleport(Entity entity, Location location, PlayerTeleportEvent.TeleportCause cause) {
        if (ShimCore.FOLIA) {
            entity.teleportAsync(location, cause);
            return true;
        }
        return entity.teleport(location, cause);
    }

    public static boolean teleport(Entity entity, Entity destination) {
        if (ShimCore.FOLIA) {
            entity.teleportAsync(destination.getLocation());
            return true;
        }
        return entity.teleport(destination);
    }

    // ===== Entity mutations that require the entity's region thread =====
    // On Folia, changing an entity (potion effects, health, velocity, …) throws
    // a main-thread check unless done on that entity's region thread. Plugins
    // often call these from a global-scheduler task or event on the wrong
    // thread. We run synchronously when already on the entity's region, and
    // otherwise reroute onto the entity's scheduler. The boolean returns are
    // optimistic (true) on the deferred path — the mutation happens next tick.

    // Package-private so the auto-generated ShimGenerated class can reuse them.
    static boolean ownsEntity(Entity entity) {
        return !ShimCore.FOLIA || ShimCore.ownScheduler().isOwnedByCurrentRegion(entity);
    }

    /** Run a void entity mutation now if we own the region, else on the entity's scheduler. */
    static void onEntity(Entity entity, Runnable action) {
        if (ownsEntity(entity)) {
            action.run();
        } else {
            ShimCore.ownScheduler().runAtEntity(entity, task -> action.run());
        }
    }

    private static boolean ownsLocation(Location loc) {
        return !ShimCore.FOLIA || ShimCore.ownScheduler().isOwnedByCurrentRegion(loc);
    }

    /** Run a void location/block mutation now if we own the region, else on that region. */
    private static void onLocation(Location loc, Runnable action) {
        if (ownsLocation(loc)) {
            action.run();
        } else {
            ShimCore.ownScheduler().runAtLocation(loc, task -> action.run());
        }
    }

    // Void entity mutators mined from Folia's region guards — fire-and-forget,
    // so deferring to the entity's region thread preserves behavior.

    public static void remove(Entity e) {
        onEntity(e, e::remove);
    }

    public static void setFireTicks(Entity e, int ticks) {
        onEntity(e, () -> e.setFireTicks(ticks));
    }

    public static void setVelocity(Entity e, Vector velocity) {
        onEntity(e, () -> e.setVelocity(velocity));
    }

    public static void setFallDistance(Entity e, float distance) {
        onEntity(e, () -> e.setFallDistance(distance));
    }

    public static void setCustomNameVisible(Entity e, boolean visible) {
        onEntity(e, () -> e.setCustomNameVisible(visible));
    }

    public static void setGlowing(Entity e, boolean glowing) {
        onEntity(e, () -> e.setGlowing(glowing));
    }

    public static void setGravity(Entity e, boolean gravity) {
        onEntity(e, () -> e.setGravity(gravity));
    }

    public static void setSilent(Entity e, boolean silent) {
        onEntity(e, () -> e.setSilent(silent));
    }

    public static void setHealth(Damageable e, double health) {
        onEntity(e, () -> e.setHealth(health));
    }

    public static void damage(Damageable e, double amount) {
        onEntity(e, () -> e.damage(amount));
    }

    public static void setAI(LivingEntity e, boolean ai) {
        onEntity(e, () -> e.setAI(ai));
    }

    public static void setCollidable(LivingEntity e, boolean collidable) {
        onEntity(e, () -> e.setCollidable(collidable));
    }

    public static void setRemoveWhenFarAway(LivingEntity e, boolean remove) {
        onEntity(e, () -> e.setRemoveWhenFarAway(remove));
    }

    public static boolean addPotionEffect(LivingEntity entity, PotionEffect effect) {
        if (ownsEntity(entity)) {
            return entity.addPotionEffect(effect);
        }
        ShimCore.ownScheduler().runAtEntity(entity, task -> entity.addPotionEffect(effect));
        return true;
    }

    public static boolean addPotionEffect(LivingEntity entity, PotionEffect effect, boolean force) {
        if (ownsEntity(entity)) {
            return entity.addPotionEffect(effect, force);
        }
        ShimCore.ownScheduler().runAtEntity(entity, task -> entity.addPotionEffect(effect, force));
        return true;
    }

    public static boolean addPotionEffects(LivingEntity entity, Collection<PotionEffect> effects) {
        if (ownsEntity(entity)) {
            return entity.addPotionEffects(effects);
        }
        ShimCore.ownScheduler().runAtEntity(entity, task -> entity.addPotionEffects(effects));
        return true;
    }

    public static void removePotionEffect(LivingEntity entity, PotionEffectType type) {
        if (ownsEntity(entity)) {
            entity.removePotionEffect(type);
        } else {
            ShimCore.ownScheduler().runAtEntity(entity, task -> entity.removePotionEffect(type));
        }
    }

    public static void damage(Damageable e, double amount, Entity source) {
        onEntity(e, () -> e.damage(amount, source));
    }

    public static void setExperience(ExperienceOrb orb, int experience) {
        onEntity(orb, () -> orb.setExperience(experience));
    }

    public static boolean pullHookedEntity(FishHook hook) {
        if (ownsEntity(hook)) {
            return hook.pullHookedEntity();
        }
        ShimCore.ownScheduler().runAtEntity(hook, task -> hook.pullHookedEntity());
        return true;
    }

    // Nameable-declared name setters: the call sites here are entities (Entity
    // extends Nameable), so an Entity receiver both compiles and reroutes.
    public static void customName(Entity e, net.kyori.adventure.text.Component name) {
        onEntity(e, () -> e.customName(name));
    }

    @SuppressWarnings("deprecation")
    public static void setCustomName(Entity e, String name) {
        onEntity(e, () -> e.setCustomName(name));
    }

    public static void setItemStack(org.bukkit.entity.ItemDisplay display, ItemStack item) {
        onEntity(display, () -> display.setItemStack(item));
    }

    public static void setItemStack(org.bukkit.entity.Item item, ItemStack stack) {
        onEntity(item, () -> item.setItemStack(stack));
    }

    // ArmorStand declares its own setVisible — it is NOT Entity.setVisibleByDefault,
    // so the generated ItemFrame.setVisible shim never matches these call sites.
    public static void setVisible(org.bukkit.entity.ArmorStand stand, boolean visible) {
        onEntity(stand, () -> stand.setVisible(visible));
    }

    // World method routed by block position (the event's vibration source).
    public static void sendGameEvent(
            org.bukkit.World world,
            Entity source,
            org.bukkit.GameEvent event,
            org.bukkit.util.Vector position) {
        Location loc = new Location(world, position.getX(), position.getY(), position.getZ());
        onLocation(loc, () -> world.sendGameEvent(source, event, position));
    }

    /** Returns null on the deferred path — the inventory opens next tick. */
    public static InventoryView openInventory(HumanEntity human, Inventory inventory) {
        if (ownsEntity(human)) {
            return human.openInventory(inventory);
        }
        ShimCore.ownScheduler().runAtEntity(human, task -> human.openInventory(inventory));
        return null;
    }

    /** Returns null on the deferred path — the merchant opens next tick. */
    public static InventoryView openMerchant(HumanEntity human, Merchant merchant, boolean force) {
        if (ownsEntity(human)) {
            return human.openMerchant(merchant, force);
        }
        ShimCore.ownScheduler().runAtEntity(human, task -> human.openMerchant(merchant, force));
        return null;
    }

    // ===== Inventory mutations — region-locked to the holder/viewer, if any =====
    // A GUI/virtual inventory has no world-backed holder and isn't region-locked,
    // so it runs synchronously; a player- or block-backed inventory reroutes to
    // that entity's or block's region.

    public static void setItem(Inventory inventory, int slot, ItemStack item) {
        InventoryHolder holder = inventory.getHolder();
        if (holder instanceof Entity entity) {
            onEntity(entity, () -> inventory.setItem(slot, item));
        } else if (holder instanceof BlockState block) {
            onLocation(block.getLocation(), () -> inventory.setItem(slot, item));
        } else {
            inventory.setItem(slot, item);
        }
    }

    public static void setItem(InventoryView view, int slot, ItemStack item) {
        HumanEntity viewer = view.getPlayer();
        if (viewer != null) {
            onEntity(viewer, () -> view.setItem(slot, item));
        } else {
            view.setItem(slot, item);
        }
    }

    // ===== Block state — region-locked by the block's location =====

    public static boolean update(BlockState state) {
        return update(state, false, true);
    }

    public static boolean update(BlockState state, boolean force) {
        return update(state, force, true);
    }

    public static boolean update(BlockState state, boolean force, boolean applyPhysics) {
        if (ownsLocation(state.getLocation())) {
            return state.update(force, applyPhysics);
        }
        ShimCore.ownScheduler().runAtLocation(state.getLocation(), task -> state.update(force, applyPhysics));
        return true;
    }

    // ===== Command dispatch — runs on the global region thread on Folia =====

    public static boolean dispatchCommand(Server server, CommandSender sender, String commandLine) {
        if (!ShimCore.FOLIA || ShimCore.ownScheduler().isGlobalTickThread()) {
            return server.dispatchCommand(sender, commandLine);
        }
        ShimCore.ownScheduler().runNextTick(task -> server.dispatchCommand(sender, commandLine));
        return true;
    }

    private Shim() {
    }
}
