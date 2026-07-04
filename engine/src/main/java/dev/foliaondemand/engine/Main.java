package dev.foliaondemand.engine;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;

/**
 * Entry point of the engine. Two protocols:
 *  - one-shot commands (JSON result on stdout), kept for debugging;
 *  - daemon mode: newline-delimited JSON requests on stdin, one JSON response
 *    line each — the JVM starts once per session, so batch runs and the GUI
 *    pay startup cost a single time and benefit from JIT warm-up.
 */
public final class Main {

    public static void main(String[] args) throws Exception {
        ObjectMapper mapper = new ObjectMapper();

        if (args.length == 1 && "daemon".equals(args[0])) {
            runDaemon(mapper);
            return;
        }
        if (args.length == 2 && "index".equals(args[0])) {
            Indexer.IndexResult result = Indexer.indexJar(Path.of(args[1]));
            mapper.writeValue(System.out, result);
            System.out.flush();
            return;
        }
        if (args.length == 2 && "transform".equals(args[0])) {
            Transform.Job job = mapper.readValue(Path.of(args[1]).toFile(), Transform.Job.class);
            Transform.Result result = Transform.run(job);
            mapper.writeValue(System.out, result);
            System.out.flush();
            return;
        }
        if (args.length == 4 && "extract".equals(args[0])) {
            mapper.writeValue(System.out, JarTools.extract(Path.of(args[1]), Path.of(args[2]), args[3]));
            System.out.flush();
            return;
        }
        if (args.length == 4 && "updatejar".equals(args[0])) {
            mapper.writeValue(System.out, JarTools.update(Path.of(args[1]), Path.of(args[2]), Path.of(args[3])));
            System.out.flush();
            return;
        }
        if (args.length >= 3 && "minefolia".equals(args[0])) {
            int maxDepth = Integer.parseInt(args[1]);
            java.util.List<Path> jars = new java.util.ArrayList<>();
            for (int i = 2; i < args.length; i++) {
                jars.add(Path.of(args[i]));
            }
            mapper.writeValue(System.out, FoliaMiner.mine(jars, maxDepth));
            System.out.flush();
            return;
        }
        System.err.println("usage: engine daemon | index <jar> | transform <job.json>"
                + " | extract <jar> <outDir> <classesCsv> | updatejar <inJar> <classesDir> <outJar>");
        System.exit(2);
    }

    private static void runDaemon(ObjectMapper mapper) throws Exception {
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String line;
        while ((line = in.readLine()) != null) {
            if (line.isBlank()) {
                continue;
            }
            long id = -1;
            String out;
            try {
                JsonNode req = mapper.readTree(line);
                id = req.path("id").asLong(-1);
                String cmd = req.path("cmd").asText("");
                Object result = switch (cmd) {
                    case "ping" -> java.util.Map.of("pong", true);
                    case "index" -> Indexer.indexJar(Path.of(req.get("jar").asText()));
                    case "transform" -> Transform.run(mapper.treeToValue(req.get("job"), Transform.Job.class));
                    case "extract" -> JarTools.extract(Path.of(req.get("jar").asText()),
                            Path.of(req.get("outDir").asText()), req.get("classes").asText());
                    case "updatejar" -> JarTools.update(Path.of(req.get("inputJar").asText()),
                            Path.of(req.get("classesDir").asText()), Path.of(req.get("outputJar").asText()));
                    case "meta" -> {
                        java.util.List<String> jars = new java.util.ArrayList<>();
                        req.get("jars").forEach(j -> jars.add(j.asText()));
                        yield JarTools.meta(jars);
                    }
                    default -> throw new IllegalArgumentException("unknown cmd: " + cmd);
                };
                // Serialize the payload directly (no intermediate JsonNode tree —
                // index results for large jars are tens of MB).
                out = "{\"id\":" + id + ",\"ok\":true,\"result\":" + mapper.writeValueAsString(result) + "}";
            } catch (Exception e) {
                out = "{\"id\":" + id + ",\"ok\":false,\"error\":" + mapper.writeValueAsString(e.toString()) + "}";
            }
            System.out.println(out);
            System.out.flush();
        }
    }

    private Main() {
    }
}
