// Test double: pretends to be a folia-on-demand server from an OLD version
// squatting on the app port. The launcher should detect the version mismatch,
// POST /api/shutdown, and start a real server after we exit.
const http = require("http");
const srv = http.createServer((req, res) => {
  if (req.url === "/api/status") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ version: "0.0.1-stale" }));
  } else if (req.url === "/api/shutdown" && req.method === "POST") {
    console.log("STALE SERVER: told to shut down — exiting");
    res.end(JSON.stringify({ ok: true }));
    setTimeout(() => process.exit(0), 100);
  } else {
    res.statusCode = 404;
    res.end();
  }
});
srv.listen(4646, "127.0.0.1", () => console.log("fake stale server on 4646"));
