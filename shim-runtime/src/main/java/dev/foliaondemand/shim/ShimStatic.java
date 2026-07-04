package dev.foliaondemand.shim;

import org.bukkit.Bukkit;
import org.bukkit.command.CommandSender;

/**
 * Redirect targets for static {@code Bukkit.*} calls that are only valid on a
 * region thread under Folia. Unlike {@link Shim}, these mirror the original
 * static method exactly (same name, same descriptor, no receiver argument) —
 * the Tier 1 rewrite turns {@code INVOKESTATIC Bukkit.foo} into
 * {@code INVOKESTATIC ShimStatic.foo}.
 */
public final class ShimStatic {

    /**
     * {@link Bukkit#getCurrentTick()} throws {@code IllegalStateException} on
     * Folia when called off a region thread (there is no "current" tick without
     * a ticking region). Plugins call it for per-tick cooldowns/dedup and expect
     * a monotonically increasing counter, not the crash. We return the real tick
     * when it's available (and cache it), and otherwise a wall-clock estimate
     * that stays continuous with the last real value.
     */
    public static int getCurrentTick() {
        try {
            return ShimCore.syncTick(Bukkit.getCurrentTick());
        } catch (Throwable notOnRegionThread) {
            return ShimCore.approxTick();
        }
    }

    /** Static Bukkit.dispatchCommand — command execution belongs on the global region thread. */
    public static boolean dispatchCommand(CommandSender sender, String commandLine) {
        if (!ShimCore.FOLIA || ShimCore.ownScheduler().isGlobalTickThread()) {
            return Bukkit.dispatchCommand(sender, commandLine);
        }
        ShimCore.ownScheduler().runNextTick(task -> Bukkit.dispatchCommand(sender, commandLine));
        return true;
    }

    private ShimStatic() {
    }
}
