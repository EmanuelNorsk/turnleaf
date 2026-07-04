package dev.foliaondemand.engine;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;
import java.util.jar.JarOutputStream;
import java.util.stream.Stream;
import java.util.zip.ZipEntry;

/** Small jar utilities for the Tier 3 pipeline: class extraction and class replacement. */
public final class JarTools {

    public record ExtractResult(int extracted, List<String> files) {
    }

    public record UpdateResult(int replaced, int added) {
    }

    /**
     * Extracts the given classes (internal names, comma-separated) plus their
     * inner classes into outDir, preserving package paths.
     */
    public static ExtractResult extract(Path jar, Path outDir, String classesCsv) throws IOException {
        Set<String> wanted = new HashSet<>(List.of(classesCsv.split(",")));
        List<String> written = new ArrayList<>();
        try (JarFile in = new JarFile(jar.toFile())) {
            Enumeration<JarEntry> entries = in.entries();
            while (entries.hasMoreElements()) {
                JarEntry entry = entries.nextElement();
                String name = entry.getName();
                if (!name.endsWith(".class")) {
                    continue;
                }
                String cls = name.substring(0, name.length() - ".class".length());
                String outer = cls.contains("$") ? cls.substring(0, cls.indexOf('$')) : cls;
                if (!wanted.contains(cls) && !wanted.contains(outer)) {
                    continue;
                }
                Path target = outDir.resolve(name);
                Files.createDirectories(target.getParent());
                try (InputStream is = in.getInputStream(entry)) {
                    Files.write(target, is.readAllBytes());
                }
                written.add(name);
            }
        }
        return new ExtractResult(written.size(), written);
    }

    public record JarMeta(String jar, String pluginYml, String properties) {
    }

    /**
     * Reads only plugin.yml (or paper-plugin.yml) and this converter's audit
     * stamp from each jar — fast enough to call for a whole library of jars,
     * unlike a full index.
     */
    public static List<JarMeta> meta(List<String> jars) {
        List<JarMeta> out = new ArrayList<>();
        for (String jarPath : jars) {
            String yml = null;
            String properties = null;
            try (JarFile in = new JarFile(jarPath)) {
                JarEntry entry = in.getJarEntry("plugin.yml");
                if (entry == null) {
                    entry = in.getJarEntry("paper-plugin.yml");
                }
                if (entry != null) {
                    yml = readEntry(in, entry);
                }
                JarEntry stamp = in.getJarEntry("folia-on-demand.properties");
                if (stamp != null) {
                    properties = readEntry(in, stamp);
                }
            } catch (IOException ignored) {
                // unreadable jar → null meta
            }
            out.add(new JarMeta(jarPath, yml, properties));
        }
        return out;
    }

    private static String readEntry(JarFile in, JarEntry entry) throws IOException {
        try (InputStream is = in.getInputStream(entry)) {
            return new String(is.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
        }
    }

    /** Copies inputJar to outputJar, replacing/adding every .class found under classesDir. */
    public static UpdateResult update(Path inputJar, Path classesDir, Path outputJar) throws IOException {
        Set<String> replacements = new HashSet<>();
        try (Stream<Path> walk = Files.walk(classesDir)) {
            walk.filter(p -> p.toString().endsWith(".class"))
                    .forEach(p -> replacements.add(classesDir.relativize(p).toString().replace('\\', '/')));
        }

        int replaced = 0;
        int added = 0;
        Set<String> written = new HashSet<>();
        if (outputJar.getParent() != null) {
            Files.createDirectories(outputJar.getParent());
        }
        try (JarFile in = new JarFile(inputJar.toFile());
             JarOutputStream out = new JarOutputStream(Files.newOutputStream(outputJar))) {
            Enumeration<JarEntry> entries = in.entries();
            while (entries.hasMoreElements()) {
                JarEntry entry = entries.nextElement();
                String name = entry.getName();
                if (entry.isDirectory() || !written.add(name)) {
                    continue;
                }
                out.putNextEntry(new ZipEntry(name));
                if (replacements.contains(name)) {
                    out.write(Files.readAllBytes(classesDir.resolve(name)));
                    replaced++;
                } else {
                    try (InputStream is = in.getInputStream(entry)) {
                        is.transferTo(out);
                    }
                }
                out.closeEntry();
            }
            for (String name : replacements) {
                if (written.add(name)) {
                    out.putNextEntry(new ZipEntry(name));
                    out.write(Files.readAllBytes(classesDir.resolve(name)));
                    out.closeEntry();
                    added++;
                }
            }
        }
        return new UpdateResult(replaced, added);
    }

    private JarTools() {
    }
}
