package dev.foliaondemand.engine;

import org.objectweb.asm.AnnotationVisitor;
import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.FieldVisitor;
import org.objectweb.asm.Handle;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Enumeration;
import java.util.List;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;

/**
 * Reads every class in a plugin jar and produces a summary the TypeScript side
 * uses for rule matching and shared-state analysis: class hierarchy, declared
 * fields, and per-method invocations (including method-reference handles
 * hidden in invokedynamic), field accesses, and annotations.
 */
public final class Indexer {

    public record IndexResult(String jar, String pluginYml, List<ClassInfo> classes, List<String> warnings) {
    }

    public record ClassInfo(String name, String superName, List<String> interfaces, int access,
                            List<FieldInfo> fields, List<MethodInfo> methods) {
    }

    public record FieldInfo(String name, String desc, int access) {
    }

    public record MethodInfo(String name, String desc, int access, List<String> annotations,
                             List<InvocationInfo> invocations, List<FieldAccess> fieldAccesses) {
    }

    /**
     * {@code handle} marks method-reference/lambda targets from invokedynamic (not direct calls).
     * {@code seq} orders invocations and field accesses within one method, so the analyzer can
     * bind a mutating call (map.put) to the field read that produced its receiver.
     */
    public record InvocationInfo(String owner, String name, String desc, boolean itf, boolean handle, int seq) {
    }

    public record FieldAccess(String owner, String name, String desc, boolean write, int seq) {
    }

    public static IndexResult indexJar(Path jarPath) throws IOException {
        List<ClassInfo> classes = new ArrayList<>();
        List<String> warnings = new ArrayList<>();
        String pluginYml = null;

        try (JarFile jar = new JarFile(jarPath.toFile())) {
            Enumeration<JarEntry> entries = jar.entries();
            while (entries.hasMoreElements()) {
                JarEntry entry = entries.nextElement();
                String name = entry.getName();
                if (name.equals("plugin.yml") || (pluginYml == null && name.equals("paper-plugin.yml"))) {
                    try (InputStream in = jar.getInputStream(entry)) {
                        pluginYml = new String(in.readAllBytes(), StandardCharsets.UTF_8);
                    }
                } else if (name.endsWith(".class")
                        && !name.startsWith("META-INF/")
                        && !name.endsWith("module-info.class")) {
                    try (InputStream in = jar.getInputStream(entry)) {
                        classes.add(readClass(in.readAllBytes()));
                    } catch (Exception e) {
                        warnings.add(name + ": " + e);
                    }
                }
            }
        }
        return new IndexResult(jarPath.toString(), pluginYml, classes, warnings);
    }

    private static ClassInfo readClass(byte[] bytes) {
        List<FieldInfo> fields = new ArrayList<>();
        List<MethodInfo> methods = new ArrayList<>();
        List<String> interfaces = new ArrayList<>();
        String[] header = new String[2];
        int[] classAccess = new int[1];

        new ClassReader(bytes).accept(new ClassVisitor(Opcodes.ASM9) {
            @Override
            public void visit(int version, int access, String name, String signature, String superName,
                              String[] itfs) {
                header[0] = name;
                header[1] = superName;
                classAccess[0] = access;
                if (itfs != null) {
                    interfaces.addAll(Arrays.asList(itfs));
                }
            }

            @Override
            public FieldVisitor visitField(int access, String name, String desc, String signature, Object value) {
                fields.add(new FieldInfo(name, desc, access));
                return null;
            }

            @Override
            public MethodVisitor visitMethod(int access, String name, String desc, String signature,
                                             String[] exceptions) {
                List<String> annotations = new ArrayList<>();
                List<InvocationInfo> invocations = new ArrayList<>();
                List<FieldAccess> fieldAccesses = new ArrayList<>();
                methods.add(new MethodInfo(name, desc, access, annotations, invocations, fieldAccesses));
                return new MethodVisitor(Opcodes.ASM9) {
                    private int seq = 0;

                    @Override
                    public AnnotationVisitor visitAnnotation(String annotationDesc, boolean visible) {
                        annotations.add(annotationDesc);
                        return null;
                    }

                    @Override
                    public void visitMethodInsn(int opcode, String owner, String mname, String mdesc, boolean itf) {
                        invocations.add(new InvocationInfo(owner, mname, mdesc, itf, false, seq++));
                    }

                    @Override
                    public void visitInvokeDynamicInsn(String iname, String idesc, Handle bsm, Object... bsmArgs) {
                        // Method references (Entity::teleport, lambdas) hide
                        // their target inside the bootstrap arguments.
                        for (Object arg : bsmArgs) {
                            if (arg instanceof Handle h) {
                                invocations.add(new InvocationInfo(h.getOwner(), h.getName(), h.getDesc(),
                                        h.isInterface(), true, seq));
                            }
                        }
                        seq++;
                    }

                    @Override
                    public void visitFieldInsn(int opcode, String owner, String fname, String fdesc) {
                        boolean write = opcode == Opcodes.PUTFIELD || opcode == Opcodes.PUTSTATIC;
                        fieldAccesses.add(new FieldAccess(owner, fname, fdesc, write, seq++));
                    }
                };
            }
        }, ClassReader.SKIP_FRAMES | ClassReader.SKIP_DEBUG);

        return new ClassInfo(header[0], header[1], interfaces, classAccess[0], fields, methods);
    }

    private Indexer() {
    }
}
