# Plugin compatibility

Plugins we have personally converted and **boot-verified on a real Folia server** (Folia 26.1.2). "Clean" means: 0 scheduler blockers, 0 region-lock risks after conversion, and the plugin enables without plugin-scoped errors on boot.

Most rows below come from a sweep of the top 60 Paper/Spigot plugins on Modrinth (July 2026), run with the built-in `turnleaf corpus` command. Conversion quality improves over time — if a plugin failed here on an older version of this tool, re-convert with the latest release before concluding anything. Rows that touch world settings (Multiverse, InvSee++, PowerRanks) need a build newer than v1.0.0.

## Converted and boot-verified

| Plugin | Version tested | Result | Notes |
|---|---|---|---|
| Advanced Backups | 3.7.1 | ✅ clean | |
| AdvancedEnchantments | 9.23.8 | ✅ clean | 41 scheduler blockers fixed |
| AdvancedPets | 2.22.14 | ✅ clean | needs Vault installed (its Vault hook throws without it) |
| BlueMap | 5.22 | ✅ clean | |
| BuildPaste | 1.11.1 | ✅ clean | |
| CalcMod | 1.5.1 | ✅ clean | |
| Common Network | 1.0.23 | ✅ clean | |
| CustomDrops | (revamped) | ✅ clean | |
| EssentialsX | 2.22.1-dev | ✅ clean | 2.22.0 stable also verified |
| InvSee++ | 0.31.15 | ✅ clean | ships `folia-supported: false` plus a delay-0 bug in its own dormant Folia path — the converter overrides the flag and clamps the delay |
| ItemsAdder | 4.0.17 | ✅ clean | requires ProtocolLib **dev build** (rejects stable) — convert that too |
| ItemSwapper | 0.2.1 | ✅ clean | |
| JourneyMap | 6.0.0 | ✅ clean | |
| Let Me Despawn | 1.0.0 | ✅ clean | |
| LifeStealZ | 2.21.1 | ✅ clean | |
| Multiverse-Core | 5.7.2-pre.2 | ✅ clean | convert + **AI Repair** — the repair patches its spawn-safety probe to skip off-region reads on Folia |
| Multiverse-Inventories | 5.3.5-pre | ✅ clean | boots clean alongside repaired Multiverse-Core |
| MythicEnchants | 5.13.0 | ✅ clean | requires MythicMobs |
| MythicMobs (Premium) | 5.13.0 | ✅ clean | |
| OneBlock | 1.6.2 | ✅ clean | |
| Oraxen | 1.217.0 | ✅ clean | |
| PlayerKits 2 | 1.23.1 | ✅ clean | |
| PowerRanks | 1.10.10 | ✅ clean | convert + **AI Repair** — tablist rank sorting turns itself off with a one-line warning (Folia does not support scoreboard team registration); everything else works |
| ProtocolLib | dev build | ✅ clean | converted as a dependency for ItemsAdder |
| Server Redirect | 1.4.3 | ✅ clean | |
| SetHome | 6.2 | ✅ clean | |
| TabTPS | 1.4.1 | ✅ clean | |
| TPS HUD | 1.9.0 | ✅ clean | |
| Vault | 1.7.3 | ✅ clean | converted as a dependency for AdvancedPets |
| Villager In A Bucket | 1.5.0 | ✅ clean | |
| VoxelMap-Updated | 1.16.7 | ✅ clean | |

## Boots, but with plugin-side errors

| Plugin | Version tested | Result | Notes |
|---|---|---|---|
| Discord Integration | 3.0.7.1 | 🟡 boots with errors | the only boot error is the unconfigured `INSERT BOT TOKEN` placeholder — the conversion itself is clean; set your token and try it |
| Orbital Strike Cannon | 7.0 | 🟡 boots with errors | calls `Bukkit.reloadData()` in `onEnable`, which Folia cannot do — the plugin catches the failure itself and keeps working; the boot error is cosmetic |

## Needs an author update

| Plugin | Version tested | Result | Notes |
|---|---|---|---|
| Dynmap | 3.7-beta-8 | ❌ needs author update | boots, but its NMS-reflection layer does not recognize Folia (`Cannot find net.minecraft.server.BiomeBase`), so map rendering fails |
| FastAsyncWorldEdit | 2.15.2 | ❌ needs author update | its own boot banner says this FAWE build does not support this Minecraft version — it fails identically on plain Paper; not a Folia/conversion issue |
| WolfyUtilities | 4.17-beta.1 | ❌ needs author update | uses legacy NMS (versioned CraftBukkit package + per-version NMS adapters). Would fail on plain modern Paper too — not a Folia/conversion issue. AI Repair fixed its version parsing, but it ships no NMS adapter for modern Minecraft. |
| CustomCrafting | 4.17-beta.5 | ❌ blocked | hard-depends on WolfyUtilities (above) |

## Already Folia-native (no conversion needed)

These popular plugins ship native Folia support as-is — install them directly: VeinMiner, Simple Voice Chat, VeinMiner Enchantment, Chunky, Chunky Border, WorldEdit, WorldGuard, Emotecraft, Plasmo Voice, Simple Voice Chat Discord Bridge, Customizable Player Models, ViaVersion, ViaBackwards, ViaRewind, LuckPerms, PatPat, SkinsRestorer, Geyser, TAB, PacketEvents, Terra, Grim Anticheat, DiscordSRV, Click Villagers, mclo.gs, CoreProtect, FancyNpcs, FancyHolograms, NBT-API, CrazyCrates, Infinite Villager Trading, LagFixer, AuthMe ReReloaded, ImageFrame.

---

**How these were tested**: converted plugins are booted together in groups of up to 6 (dependencies kept in the same group), on a fresh Folia 26.1.2 server. Groups verified by hand: ProtocolLib + Vault + ItemsAdder + Oraxen + CustomDrops + AdvancedPets (PASS), and AdvancedEnchantments + EssentialsX + MythicEnchants + MythicMobs (PASS).

Converted a plugin yourself? Open an issue (the app's crash analyzer has a one-click **Report** button) or a PR adding a row — plugin name, version, result, and any dependency notes.
