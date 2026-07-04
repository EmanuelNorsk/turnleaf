package dev.foliaondemand.engine;

import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.ClassWriter;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;
import org.objectweb.asm.commons.ClassRemapper;
import org.objectweb.asm.commons.Remapper;
import org.objectweb.asm.tree.AbstractInsnNode;
import org.objectweb.asm.tree.ClassNode;
import org.objectweb.asm.tree.FieldInsnNode;
import org.objectweb.asm.tree.InsnList;
import org.objectweb.asm.tree.IntInsnNode;
import org.objectweb.asm.tree.LdcInsnNode;
import org.objectweb.asm.tree.LineNumberNode;
import org.objectweb.asm.tree.MethodInsnNode;
import org.objectweb.asm.tree.MethodNode;
import org.objectweb.asm.tree.TypeInsnNode;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;
import java.util.jar.JarOutputStream;
import java.util.jar.Manifest;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;

/**
 * Tier 1 rewrite: redirects matched instance-method call sites to static shim
 * methods (receiver becomes the first argument — stack shape is identical, so
 * no frame recomputation is needed), injects the relocated shim classes,
 * patches plugin.yml, and strips jar-signing metadata.
 */
public final class Transform {

    // ---- Job model (deserialized from the TypeScript-built JSON job) ----

    public record Job(String inputJar, String outputJar, List<Redirect> redirects, String injectJar,
                      Relocation relocation, boolean setFoliaSupported, List<CollectionFix> collectionFixes,
                      Map<String, String> stamp) {
    }

    public record Redirect(String id, List<String> owners, String ownerPrefix, String name, String desc,
                           String targetOwner, String targetName, String targetDesc, boolean staticCall) {
    }

    public record Relocation(String fromPrefix, String toPrefix) {
    }

    /** Tier 2 candidate: a field whose collection allocations should become thread-safe. */
    public record CollectionFix(String fieldOwner, String fieldName) {
    }

    public record AppliedFix(String field, String strategy, int sites, int unmatchedWrites) {
    }

    public record Result(int classesScanned, int classesModified, Map<String, Integer> rewrites, int injectedClasses,
                         boolean pluginYmlPatched, List<String> strippedEntries, List<AppliedFix> concurrencyFixes,
                         List<String> warnings, List<String> modifiedClasses) {
    }

    /** How each unsafe allocation type becomes thread-safe (frame-safe edits only). */
    private record Strategy(String kind, String replaceType, String wrapMethod, String ifaceDesc, String label) {
    }

    private static final Map<String, Strategy> STRATEGIES = Map.of(
            // NOTE: HashMap -> Collections.synchronizedMap, NOT ConcurrentHashMap.
            // ConcurrentHashMap rejects null keys/values (throws NPE), so it is
            // not a behavior-preserving drop-in — e.g. SnakeYAML's Resolver uses
            // a null map key and breaks under ConcurrentHashMap. synchronizedMap
            // preserves HashMap's null tolerance and iteration contract exactly.
            "java/util/HashMap",
            new Strategy("wrap", null, "synchronizedMap", "Ljava/util/Map;", "Collections.synchronizedMap"),
            "java/util/LinkedHashMap",
            new Strategy("wrap", null, "synchronizedMap", "Ljava/util/Map;", "Collections.synchronizedMap"),
            "java/util/HashSet",
            new Strategy("wrap", null, "synchronizedSet", "Ljava/util/Set;", "Collections.synchronizedSet"),
            "java/util/LinkedHashSet",
            new Strategy("wrap", null, "synchronizedSet", "Ljava/util/Set;", "Collections.synchronizedSet"),
            "java/util/TreeSet",
            new Strategy("wrap", null, "synchronizedSet", "Ljava/util/Set;", "Collections.synchronizedSet"),
            "java/util/ArrayList",
            new Strategy("wrap", null, "synchronizedList", "Ljava/util/List;", "Collections.synchronizedList"),
            "java/util/LinkedList",
            new Strategy("wrap", null, "synchronizedList", "Ljava/util/List;", "Collections.synchronizedList"));

    private static final Pattern FOLIA_SUPPORTED = Pattern.compile("(?m)^\\s*folia-supported\\s*:");
    private static final Pattern SIGNATURE_FILE = Pattern.compile("META-INF/[^/]+\\.(SF|RSA|DSA|EC)");

    public static Result run(Job job) throws IOException {
        Map<String, List<Redirect>> table = new HashMap<>();
        for (Redirect r : job.redirects()) {
            table.computeIfAbsent(r.name() + r.desc(), k -> new ArrayList<>()).add(r);
        }

        Map<String, Integer> rewriteCounts = new HashMap<>();
        List<String> warnings = new ArrayList<>();
        List<String> stripped = new ArrayList<>();
        Set<String> writtenEntries = new HashSet<>();

        Map<String, CollectionFix> fixIndex = new HashMap<>();
        if (job.collectionFixes() != null) {
            for (CollectionFix f : job.collectionFixes()) {
                fixIndex.put(f.fieldOwner() + "#" + f.fieldName(), f);
            }
        }
        Map<String, FixTally> fixStats = new HashMap<>();
        int classesScanned = 0;
        int classesModified = 0;
        int injectedClasses = 0;
        boolean pluginYmlPatched = false;
        List<String> modifiedClasses = new ArrayList<>();

        Path outPath = Path.of(job.outputJar());
        if (outPath.getParent() != null) {
            Files.createDirectories(outPath.getParent());
        }

        try (JarFile in = new JarFile(job.inputJar());
             JarOutputStream out = new JarOutputStream(Files.newOutputStream(outPath))) {

            Enumeration<JarEntry> entries = in.entries();
            while (entries.hasMoreElements()) {
                JarEntry entry = entries.nextElement();
                String name = entry.getName();
                if (entry.isDirectory()) {
                    continue;
                }
                if (SIGNATURE_FILE.matcher(name).matches()) {
                    stripped.add(name);
                    continue;
                }
                // Re-converting an already-converted jar: drop the previous run's
                // injected shim and audit stamp so the fresh ones replace them
                // wholesale (a stale shim class must never survive an upgrade).
                if (job.relocation() != null && name.startsWith(job.relocation().toPrefix() + "/")) {
                    continue;
                }
                if (name.equals("folia-on-demand.properties")) {
                    continue;
                }
                if (!writtenEntries.add(name)) {
                    warnings.add("duplicate entry skipped: " + name);
                    continue;
                }

                byte[] bytes;
                try (InputStream is = in.getInputStream(entry)) {
                    bytes = is.readAllBytes();
                }

                if (name.equals("MANIFEST.MF") || name.equals("META-INF/MANIFEST.MF")) {
                    bytes = sanitizeManifest(bytes);
                } else if (name.endsWith(".class") && !name.endsWith("module-info.class")) {
                    classesScanned++;
                    boolean modified = false;
                    byte[] transformed = transformClass(bytes, table, rewriteCounts, warnings);
                    if (transformed != null) {
                        bytes = transformed;
                        modified = true;
                    }
                    if (!fixIndex.isEmpty()) {
                        byte[] fixed = applyCollectionFixes(bytes, fixIndex, fixStats);
                        if (fixed != null) {
                            bytes = fixed;
                            modified = true;
                        }
                    }
                    if (modified) {
                        classesModified++;
                        modifiedClasses.add(name.substring(0, name.length() - ".class".length()));
                    }
                } else if ((name.equals("plugin.yml") || name.equals("paper-plugin.yml"))
                        && job.setFoliaSupported()) {
                    String yml = new String(bytes, StandardCharsets.UTF_8);
                    if (!FOLIA_SUPPORTED.matcher(yml).find()) {
                        yml = yml + (yml.endsWith("\n") ? "" : "\n") + "folia-supported: true\n";
                        bytes = yml.getBytes(StandardCharsets.UTF_8);
                        pluginYmlPatched = true;
                    }
                }

                out.putNextEntry(new ZipEntry(name));
                out.write(bytes);
                out.closeEntry();
            }

            // Audit stamp: which converter/shim produced this jar, and when.
            if (job.stamp() != null && !job.stamp().isEmpty() && writtenEntries.add("folia-on-demand.properties")) {
                StringBuilder sb = new StringBuilder();
                job.stamp().entrySet().stream()
                        .sorted(Map.Entry.comparingByKey())
                        .forEach(e -> sb.append(e.getKey()).append('=').append(e.getValue()).append('\n'));
                out.putNextEntry(new ZipEntry("folia-on-demand.properties"));
                out.write(sb.toString().getBytes(StandardCharsets.UTF_8));
                out.closeEntry();
            }

            // Inject the (relocated) shim classes.
            if (job.injectJar() != null) {
                Remapper remapper = prefixRemapper(job.relocation());
                try (JarFile shim = new JarFile(job.injectJar())) {
                    Enumeration<JarEntry> shimEntries = shim.entries();
                    while (shimEntries.hasMoreElements()) {
                        JarEntry entry = shimEntries.nextElement();
                        String name = entry.getName();
                        if (entry.isDirectory() || !name.endsWith(".class") || name.endsWith("module-info.class")
                                || name.startsWith("META-INF/")) {
                            continue;
                        }
                        byte[] bytes;
                        try (InputStream is = shim.getInputStream(entry)) {
                            bytes = is.readAllBytes();
                        }
                        ClassReader reader = new ClassReader(bytes);
                        ClassWriter writer = new ClassWriter(0);
                        reader.accept(new ClassRemapper(writer, remapper), 0);
                        String newName = remapper.map(name.substring(0, name.length() - ".class".length()))
                                + ".class";
                        if (!writtenEntries.add(newName)) {
                            throw new IOException("injection collision: " + newName + " already exists in jar");
                        }
                        out.putNextEntry(new ZipEntry(newName));
                        out.write(writer.toByteArray());
                        out.closeEntry();
                        injectedClasses++;
                    }
                }
            }
        }

        List<AppliedFix> applied = new ArrayList<>();
        for (Map.Entry<String, FixTally> e : fixStats.entrySet()) {
            FixTally t = e.getValue();
            applied.add(new AppliedFix(e.getKey(), t.label == null ? "none" : t.label, t.sites, t.unmatched));
        }

        return new Result(classesScanned, classesModified, rewriteCounts, injectedClasses, pluginYmlPatched,
                stripped, applied, warnings, modifiedClasses);
    }

    private static final class FixTally {
        int sites;
        int unmatched;
        String label;
    }

    /**
     * Rewrites collection allocations assigned to flagged fields into
     * thread-safe forms. Only strict-adjacency allocation patterns
     * (NEW, DUP, [int], &lt;init&gt;, PUTFIELD) with interface-typed fields are
     * touched — those edits provably cannot invalidate stack map frames.
     * Anything else counts as unmatched and is reported for Tier 3.
     */
    private static byte[] applyCollectionFixes(byte[] bytes, Map<String, CollectionFix> fixIndex,
                                               Map<String, FixTally> stats) {
        ClassNode node = new ClassNode();
        new ClassReader(bytes).accept(node, 0);
        boolean modified = false;

        for (MethodNode method : node.methods) {
            InsnList insns = method.instructions;
            for (AbstractInsnNode insn = insns.getFirst(); insn != null; insn = insn.getNext()) {
                if (!(insn instanceof FieldInsnNode put)
                        || (put.getOpcode() != Opcodes.PUTFIELD && put.getOpcode() != Opcodes.PUTSTATIC)) {
                    continue;
                }
                String fk = put.owner + "#" + put.name;
                if (!fixIndex.containsKey(fk)) {
                    continue;
                }
                FixTally tally = stats.computeIfAbsent(fk, k -> new FixTally());

                AbstractInsnNode initInsn = realPrev(put);
                if (!(initInsn instanceof MethodInsnNode init) || init.getOpcode() != Opcodes.INVOKESPECIAL
                        || !"<init>".equals(init.name)) {
                    tally.unmatched++;
                    continue;
                }
                Strategy strategy = STRATEGIES.get(init.owner);
                if (strategy == null || !("()V".equals(init.desc) || "(I)V".equals(init.desc))) {
                    tally.unmatched++;
                    continue;
                }
                if (!put.desc.equals(strategy.ifaceDesc())) {
                    tally.unmatched++; // concrete-typed field: retyping is not frame-safe — Tier 3
                    continue;
                }
                AbstractInsnNode cursor = realPrev(initInsn);
                if ("(I)V".equals(init.desc)) {
                    if (!isIntPush(cursor)) {
                        tally.unmatched++;
                        continue;
                    }
                    cursor = realPrev(cursor);
                }
                if (cursor == null || cursor.getOpcode() != Opcodes.DUP) {
                    tally.unmatched++;
                    continue;
                }
                AbstractInsnNode newInsn = realPrev(cursor);
                if (!(newInsn instanceof TypeInsnNode alloc) || alloc.getOpcode() != Opcodes.NEW
                        || !alloc.desc.equals(init.owner)) {
                    tally.unmatched++;
                    continue;
                }

                if ("replace".equals(strategy.kind())) {
                    alloc.desc = strategy.replaceType();
                    init.owner = strategy.replaceType();
                } else {
                    insns.insertBefore(put, new MethodInsnNode(Opcodes.INVOKESTATIC, "java/util/Collections",
                            strategy.wrapMethod(), "(" + strategy.ifaceDesc() + ")" + strategy.ifaceDesc(), false));
                }
                tally.sites++;
                tally.label = strategy.label();
                modified = true;
            }
        }

        if (!modified) {
            return null;
        }
        ClassWriter writer = new ClassWriter(0);
        node.accept(writer);
        return writer.toByteArray();
    }

    /** Previous instruction, skipping labels and line numbers but stopping at frames (branch targets). */
    private static AbstractInsnNode realPrev(AbstractInsnNode insn) {
        AbstractInsnNode prev = insn.getPrevious();
        while (prev instanceof LineNumberNode || prev instanceof org.objectweb.asm.tree.LabelNode) {
            prev = prev.getPrevious();
        }
        return prev;
    }

    private static boolean isIntPush(AbstractInsnNode insn) {
        if (insn == null) {
            return false;
        }
        int op = insn.getOpcode();
        return (op >= Opcodes.ICONST_0 && op <= Opcodes.ICONST_5)
                || insn instanceof IntInsnNode
                || (insn instanceof LdcInsnNode ldc && ldc.cst instanceof Integer);
    }

    /** Returns transformed bytes, or null if the class needed no changes. */
    private static byte[] transformClass(byte[] bytes, Map<String, List<Redirect>> table,
                                         Map<String, Integer> counts, List<String> warnings) {
        ClassReader reader = new ClassReader(bytes);
        ClassWriter writer = new ClassWriter(reader, 0);
        boolean[] modified = new boolean[1];

        reader.accept(new ClassVisitor(Opcodes.ASM9, writer) {
            @Override
            public MethodVisitor visitMethod(int access, String name, String desc, String signature,
                                             String[] exceptions) {
                MethodVisitor mv = super.visitMethod(access, name, desc, signature, exceptions);
                return new MethodVisitor(Opcodes.ASM9, mv) {
                    @Override
                    public void visitMethodInsn(int opcode, String owner, String mname, String mdesc, boolean itf) {
                        if (!mname.equals("<init>")) {
                            List<Redirect> candidates = table.get(mname + mdesc);
                            if (candidates != null) {
                                boolean isStatic = opcode == Opcodes.INVOKESTATIC;
                                // Static redirects target INVOKESTATIC call sites; instance redirects
                                // target virtual/interface calls (receiver becomes the first arg).
                                // Exact-owner matches win over prefix matches, so a more specific shim
                                // (e.g. InventoryView) is preferred over a broad one (Inventory).
                                Redirect chosen = null;
                                for (Redirect r : candidates) {
                                    if (r.staticCall() == isStatic && r.owners() != null && r.owners().contains(owner)) {
                                        chosen = r;
                                        break;
                                    }
                                }
                                if (chosen == null) {
                                    for (Redirect r : candidates) {
                                        if (r.staticCall() == isStatic && r.ownerPrefix() != null
                                                && owner.startsWith(r.ownerPrefix())) {
                                            chosen = r;
                                            break;
                                        }
                                    }
                                }
                                if (chosen != null) {
                                    counts.merge(chosen.id(), 1, Integer::sum);
                                    modified[0] = true;
                                    super.visitMethodInsn(Opcodes.INVOKESTATIC, chosen.targetOwner(),
                                            chosen.targetName(), chosen.targetDesc(), false);
                                    return;
                                }
                            }
                        }
                        super.visitMethodInsn(opcode, owner, mname, mdesc, itf);
                    }
                };
            }
        }, 0);

        return modified[0] ? writer.toByteArray() : null;
    }

    private static Remapper prefixRemapper(Relocation relocation) {
        String from = relocation.fromPrefix();
        String to = relocation.toPrefix();
        return new Remapper() {
            @Override
            public String map(String internalName) {
                if (internalName.startsWith(from)) {
                    return to + internalName.substring(from.length());
                }
                return internalName;
            }
        };
    }

    /** Drop per-entry sections (signing digests); keep main attributes. */
    private static byte[] sanitizeManifest(byte[] bytes) throws IOException {
        Manifest manifest = new Manifest(new java.io.ByteArrayInputStream(bytes));
        if (manifest.getEntries().isEmpty()) {
            return bytes;
        }
        manifest.getEntries().clear();
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        manifest.write(out);
        return out.toByteArray();
    }

    private Transform() {
    }
}
