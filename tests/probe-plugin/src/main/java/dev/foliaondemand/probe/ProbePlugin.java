package dev.foliaondemand.probe;

import org.bukkit.Bukkit;
import org.bukkit.entity.Player;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.potion.PotionEffect;
import org.bukkit.potion.PotionEffectType;
import org.bukkit.scheduler.BukkitRunnable;

import java.util.HashMap;
import java.util.Map;

/**
 * Deliberately written the "old Paper way" — every call here throws on Folia
 * until the converter has redirected it. Each scheduled task logs a marker
 * line that the verify harness asserts, proving the shim actually schedules
 * and cancels at runtime instead of merely loading.
 */
public final class ProbePlugin extends JavaPlugin {

    // Interface-typed Map mutated from a concurrent (async) context — the Tier 2
    // fixer should make it thread-safe. It must stay null-key tolerant: a
    // ConcurrentHashMap swap would NPE on get(null); synchronizedMap must not.
    private final Map<String, String> nullKeyProbe = new HashMap<>();

    @Override
    public void onEnable() {
        getLogger().info("probe: enabled");

        Bukkit.getScheduler().runTaskAsynchronously(this, () -> {
            nullKeyProbe.put("k", "v");
            String viaNull = nullKeyProbe.get(null); // NPE under ConcurrentHashMap
            getLogger().info("probe: null-key get OK (" + viaNull + ")");
        });

        Bukkit.getScheduler().runTask(this, () -> getLogger().info("probe: runTask OK"));

        Bukkit.getScheduler().runTaskLater(this, () -> getLogger().info("probe: runTaskLater OK"), 5L);

        Bukkit.getScheduler().runTaskAsynchronously(this,
                () -> getLogger().info("probe: runTaskAsynchronously OK"));

        int taskId = Bukkit.getScheduler().scheduleSyncDelayedTask(this,
                () -> getLogger().info("probe: scheduleSyncDelayedTask OK"), 5L);
        getLogger().info("probe: legacy task id " + taskId);

        new BukkitRunnable() {
            private int runs = 0;

            @Override
            public void run() {
                runs++;
                getLogger().info("probe: timer tick " + runs);
                if (runs >= 3) {
                    cancel();
                    getLogger().info("probe: timer cancelled OK");
                }
            }
        }.runTaskTimer(this, 5L, 5L);
    }

    @Override
    public void onDisable() {
        getLogger().info("probe: disabled");
    }

    /**
     * Not called at enable (no players exist yet) — present purely as a
     * region-mutation call site the converter should redirect to the shim.
     */
    @SuppressWarnings("unused")
    public void applyEffect(Player player) {
        player.addPotionEffect(new PotionEffect(PotionEffectType.SPEED, 100, 1));
    }
}
