import { describe, expect, it } from "vitest";
import { frameInfo, parseIncidents } from "./repair.js";

const WOLFY_LOG = `[01:47:39 ERROR]: [ModernPluginLoadingStrategy] Could not load plugin 'wolfyutils-folia.jar' in folder 'plugins'
java.lang.reflect.InvocationTargetException
	at java.base/jdk.internal.reflect.DirectConstructorHandleAccessor.newInstance(DirectConstructorHandleAccessor.java:74) ~[?:?]
	at io.papermc.paper.plugin.provider.util.ProviderUtil.loadClass(ProviderUtil.java:68) ~[folia-api.jar:?]
Caused by: java.lang.ExceptionInInitializerError
	at wolfyutils-folia.jar//me.wolfyscript.utilities.api.nms.NMSUtil.create(NMSUtil.java:81) ~[?:?]
	at wolfyutils-folia.jar//com.wolfyscript.utilities.bukkit.WolfyUtilsBukkit.<init>(WolfyUtilsBukkit.java:56) ~[?:?]
Caused by: java.lang.StringIndexOutOfBoundsException: Range [23, 22) out of bounds for length 22
	at wolfyutils-folia.jar//me.wolfyscript.utilities.util.Reflection.getVersion(Reflection.java:84) ~[?:?]
	... 15 more
[01:47:40 INFO]: Server started`;

const DEP_LOG = `[01:47:21 ERROR]: [ModernPluginLoadingStrategy] Could not load 'plugins\\ItemsAdder.jar' in 'plugins'
org.bukkit.plugin.UnknownDependencyException: Unknown/missing dependency plugins: [ProtocolLib]. Please download and install these plugins to run 'ItemsAdder'.
	at io.papermc.paper.plugin.entrypoint.strategy.modern.ModernPluginLoadingStrategy.loadProviders(ModernPluginLoadingStrategy.java:82)`;

const CLASSES = new Set([
  "me/wolfyscript/utilities/api/nms/NMSUtil",
  "com/wolfyscript/utilities/bukkit/WolfyUtilsBukkit",
  "me/wolfyscript/utilities/util/Reflection",
]);

describe("frameInfo", () => {
  it("parses plain frames", () => {
    expect(frameInfo("\tat com.example.Foo.bar(Foo.java:42)")).toEqual({ cls: "com.example.Foo", jar: null });
  });

  it("parses JVM-module frames (single slash)", () => {
    expect(frameInfo("\tat java.base/jdk.internal.reflect.X.newInstance(X.java:74)")).toEqual({
      cls: "jdk.internal.reflect.X",
      jar: null,
    });
  });

  it("parses Paper classloader frames (jar//)", () => {
    expect(frameInfo("\tat some-plugin-1.0.jar//com.example.Foo.bar(Foo.java:1) ~[?:?]")).toEqual({
      cls: "com.example.Foo",
      jar: "some-plugin-1.0.jar",
    });
  });

  it("returns null for non-frame lines", () => {
    expect(frameInfo("Caused by: java.lang.Error")).toBeNull();
  });
});

describe("parseIncidents", () => {
  it("finds an incident with root-cause classes first and jar attribution", () => {
    const incidents = parseIncidents(WOLFY_LOG, (cls) => CLASSES.has(cls));
    expect(incidents).toHaveLength(1);
    expect(incidents[0].classes[0]).toBe("me/wolfyscript/utilities/util/Reflection");
    expect(incidents[0].jars).toEqual(["wolfyutils-folia.jar"]);
    expect(incidents[0].excerpt).toContain("StringIndexOutOfBoundsException");
  });

  it("skips missing-dependency notices (not fixable in code)", () => {
    const incidents = parseIncidents(DEP_LOG, () => true);
    expect(incidents).toHaveLength(0);
  });

  it("dedupes repeated identical crashes", () => {
    const twice = `${WOLFY_LOG}\n${WOLFY_LOG}`;
    expect(parseIncidents(twice, (cls) => CLASSES.has(cls))).toHaveLength(1);
  });

  it("finds nothing in a clean log", () => {
    expect(parseIncidents("[12:00 INFO]: Done (3.2s)! For help, type \"help\"", () => true)).toHaveLength(0);
  });
});
