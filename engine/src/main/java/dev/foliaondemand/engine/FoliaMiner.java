package dev.foliaondemand.engine;

import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Deque;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;

/**
 * Mines a Folia server jar for the ground-truth set of Bukkit API methods that
 * require region-thread ownership (i.e. that throw when called off the owning
 * region thread). Rather than discovering these one crash at a time, we read
 * the server's own thread-check enforcement:
 *
 *  1. Find every method that calls {@code TickThread.ensureTickThread(...)} —
 *     these are the guarded internals (NMS mutators).
 *  2. Walk the call graph backwards a bounded number of hops to every method
 *     that reaches a guard.
 *  3. Keep the CraftBukkit implementation methods among those, and map each
 *     back to the Bukkit API interface method it implements — that public
 *     method is what a plugin actually calls.
 */
public final class FoliaMiner {

    public record ApiMethod(String ownerPrefix, String name, String desc, String via) {
    }

    public record MineResult(List<String> jars, int classesScanned, int directGuardCallers, int craftMethodsReached,
                             int maxDepth, List<ApiMethod> api, List<String> warnings) {
    }

    private static final String GUARD_OWNER = "ca/spottedleaf/moonrise/common/util/TickThread";
    private static final String GUARD_NAME_PREFIX = "ensureTickThread";

    private static final class Cls {
        String name;
        String superName;
        final List<String> interfaces = new ArrayList<>();
        final Set<String> methods = new HashSet<>();
    }

    public static MineResult mine(List<Path> jars, int maxDepth) throws IOException {
        Map<String, Cls> classes = new HashMap<>();
        // calleeKey ("owner#name+desc") -> caller keys that invoke it.
        Map<String, List<String>> callers = new HashMap<>();
        Set<String> directGuardCallers = new HashSet<>();
        List<String> warnings = new ArrayList<>();

        // Index the server jar (call graph + guard detection) plus the Bukkit
        // API jar (interface hierarchy + method declarations for the mapping).
        for (Path jarPath : jars) {
            try (JarFile jar = new JarFile(jarPath.toFile())) {
                Enumeration<JarEntry> entries = jar.entries();
                while (entries.hasMoreElements()) {
                    JarEntry entry = entries.nextElement();
                    String name = entry.getName();
                    if (!name.endsWith(".class") || name.startsWith("META-INF/")
                            || name.endsWith("module-info.class")) {
                        continue;
                    }
                    byte[] bytes;
                    try (InputStream is = jar.getInputStream(entry)) {
                        bytes = is.readAllBytes();
                    }
                    try {
                        readClass(bytes, classes, callers, directGuardCallers);
                    } catch (Exception e) {
                        warnings.add(name + ": " + e);
                    }
                }
            }
        }

        // Backward BFS from the guard callers up to maxDepth hops.
        Set<String> reached = new HashSet<>(directGuardCallers);
        Set<String> frontier = directGuardCallers;
        for (int depth = 0; depth < maxDepth && !frontier.isEmpty(); depth++) {
            Set<String> next = new HashSet<>();
            for (String m : frontier) {
                List<String> cs = callers.get(m);
                if (cs != null) {
                    for (String caller : cs) {
                        if (reached.add(caller)) {
                            next.add(caller);
                        }
                    }
                }
            }
            frontier = next;
        }

        // Keep CraftBukkit methods, map each to the Bukkit API method it implements.
        Set<String> emitted = new HashSet<>();
        List<ApiMethod> api = new ArrayList<>();
        int craftReached = 0;
        for (String key : reached) {
            int hash = key.indexOf('#');
            String owner = key.substring(0, hash);
            if (!owner.startsWith("org/bukkit/craftbukkit/")) {
                continue;
            }
            craftReached++;
            String nameDesc = key.substring(hash + 1);
            int paren = nameDesc.indexOf('(');
            String mname = nameDesc.substring(0, paren);
            String mdesc = nameDesc.substring(paren);
            if (mname.startsWith("<") || mname.startsWith("lambda$")) {
                continue;
            }
            for (String iface : bukkitInterfacesDeclaring(classes, owner, nameDesc)) {
                String prefix = iface.substring(0, iface.lastIndexOf('/') + 1);
                if (emitted.add(prefix + "|" + nameDesc)) {
                    api.add(new ApiMethod(prefix, mname, mdesc, iface));
                }
            }
        }
        api.sort((a, b) -> {
            int c = a.ownerPrefix().compareTo(b.ownerPrefix());
            if (c != 0) return c;
            c = a.name().compareTo(b.name());
            return c != 0 ? c : a.desc().compareTo(b.desc());
        });

        return new MineResult(jars.stream().map(Path::toString).toList(), classes.size(), directGuardCallers.size(),
                craftReached, maxDepth, api, warnings);
    }

    private static void readClass(byte[] bytes, Map<String, Cls> classes, Map<String, List<String>> callers,
                                  Set<String> directGuardCallers) {
        Cls cls = new Cls();
        new ClassReader(bytes).accept(new ClassVisitor(Opcodes.ASM9) {
            @Override
            public void visit(int version, int access, String name, String signature, String superName,
                              String[] interfaces) {
                cls.name = name;
                cls.superName = superName;
                if (interfaces != null) {
                    cls.interfaces.addAll(Arrays.asList(interfaces));
                }
                classes.put(name, cls);
            }

            @Override
            public MethodVisitor visitMethod(int access, String name, String desc, String signature,
                                             String[] exceptions) {
                String callerKey = cls.name + "#" + name + desc;
                cls.methods.add(name + desc);
                return new MethodVisitor(Opcodes.ASM9) {
                    @Override
                    public void visitMethodInsn(int opcode, String owner, String mname, String mdesc, boolean itf) {
                        if (owner.equals(GUARD_OWNER) && mname.startsWith(GUARD_NAME_PREFIX)) {
                            directGuardCallers.add(callerKey);
                        } else {
                            callers.computeIfAbsent(owner + "#" + mname + mdesc, k -> new ArrayList<>()).add(callerKey);
                        }
                    }
                };
            }
        }, ClassReader.SKIP_FRAMES | ClassReader.SKIP_DEBUG);
    }

    /** Bukkit (non-craftbukkit) interfaces in the craft class's hierarchy that declare nameDesc. */
    private static Set<String> bukkitInterfacesDeclaring(Map<String, Cls> classes, String craftOwner,
                                                         String nameDesc) {
        Set<String> ifaces = new LinkedHashSet<>();
        Set<String> visited = new HashSet<>();
        Deque<String> stack = new ArrayDeque<>();
        stack.push(craftOwner);
        while (!stack.isEmpty()) {
            String cn = stack.pop();
            if (!visited.add(cn)) {
                continue;
            }
            Cls c = classes.get(cn);
            if (c == null) {
                continue;
            }
            for (String i : c.interfaces) {
                collectBukkitInterfaces(classes, i, ifaces);
            }
            if (c.superName != null) {
                stack.push(c.superName);
            }
        }
        Set<String> declaring = new LinkedHashSet<>();
        for (String i : ifaces) {
            Cls ic = classes.get(i);
            if (ic != null && ic.methods.contains(nameDesc)) {
                declaring.add(i);
            }
        }
        return declaring;
    }

    private static void collectBukkitInterfaces(Map<String, Cls> classes, String iface, Set<String> out) {
        if (!iface.startsWith("org/bukkit/") || iface.startsWith("org/bukkit/craftbukkit/")) {
            return;
        }
        if (!out.add(iface)) {
            return;
        }
        Cls c = classes.get(iface);
        if (c != null) {
            for (String s : c.interfaces) {
                collectBukkitInterfaces(classes, s, out);
            }
        }
    }

    private FoliaMiner() {
    }
}
