# Plugin compatibility

Plugins we have personally converted and **boot-verified on a real Folia server** (Folia 26.1.2). "Clean" means: 0 scheduler blockers, 0 region-lock risks after conversion, and the plugin enables without plugin-scoped errors on boot.

Conversion quality improves over time — if a plugin failed here on an older version of this tool, re-convert with the latest release before concluding anything.

| Plugin | Version tested | Result | Notes |
|---|---|---|---|
| AdvancedEnchantments | 9.23.8 | ✅ clean | 41 scheduler blockers fixed |
| AdvancedPets | 2.22.14 | ✅ clean | needs Vault installed (its Vault hook throws without it) |
| CustomDrops | (revamped) | ✅ clean | |
| EssentialsX | 2.22.1-dev | ✅ clean | |
| ItemsAdder | 4.0.17 | ✅ clean | requires ProtocolLib **dev build** (rejects stable) — convert that too |
| MythicEnchants | 5.13.0 | ✅ clean | requires MythicMobs |
| MythicMobs (Premium) | 5.13.0 | ✅ clean | |
| Oraxen | 1.217.0 | ✅ clean | |
| ProtocolLib | dev build | ✅ clean | converted as a dependency for ItemsAdder |
| Vault | 1.7.3 | ✅ clean | converted as a dependency for AdvancedPets |
| WolfyUtilities | 4.17-beta.1 | ❌ needs author update | uses legacy NMS (versioned CraftBukkit package + per-version NMS adapters). Would fail on plain modern Paper too — not a Folia/conversion issue. AI Repair fixed its version parsing, but it ships no NMS adapter for modern Minecraft. |
| CustomCrafting | 4.17-beta.5 | ❌ blocked | hard-depends on WolfyUtilities (above) |

**Boot groups tested together**: ProtocolLib + Vault + ItemsAdder + Oraxen + CustomDrops + AdvancedPets (PASS), and AdvancedEnchantments + EssentialsX + MythicEnchants + MythicMobs (PASS).

Converted a plugin yourself? Open an issue (the app's crash analyzer has a one-click **Report** button) or a PR adding a row — plugin name, version, result, and any dependency notes.
