// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent};

const PORT: u16 = 4646;

/// Holds the spawned Node GUI-server process so we can kill it on exit.
struct Server(Mutex<Option<Child>>);

/// Walk up from the executable's directory until we find the project root
/// (the folder containing package.json and src/cli.ts) — dev mode only.
fn find_project_root() -> Option<PathBuf> {
    let mut dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    loop {
        if dir.join("package.json").exists() && dir.join("src").join("cli.ts").exists() {
            return Some(dir);
        }
        if !dir.pop() {
            return None;
        }
    }
}

fn port_open(port: u16) -> bool {
    TcpStream::connect(("127.0.0.1", port)).is_ok()
}

/// Minimal HTTP request to the local server (no client dependency needed).
fn http_localhost(method: &str, path: &str) -> Option<String> {
    use std::io::{Read, Write};
    let mut s = TcpStream::connect(("127.0.0.1", PORT)).ok()?;
    let _ = s.set_read_timeout(Some(Duration::from_secs(3)));
    write!(
        s,
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
    )
    .ok()?;
    let mut buf = String::new();
    s.read_to_string(&mut buf).ok()?;
    Some(buf)
}

/// A server is already on our port. Keep it only if it's OUR version —
/// otherwise it's a leftover from before an update: ask it to shut down so a
/// fresh server (with freshly synced resources) can take its place.
fn ensure_server_is_current(version: &str) {
    let expected = format!("\"version\":\"{version}\"");
    let current = http_localhost("GET", "/api/status").map_or(false, |r| r.contains(&expected));
    if current {
        return;
    }
    let _ = http_localhost("POST", "/api/shutdown");
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline && port_open(PORT) {
        thread::sleep(Duration::from_millis(150));
    }
}

/// GUI apps on macOS/Linux don't inherit the shell's PATH, so Homebrew/nvm
/// node installs won't resolve as plain "node" — probe the usual homes.
fn find_node() -> String {
    if cfg!(windows) {
        return "node".into();
    }
    let candidates = [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
        "/snap/bin/node",
    ];
    for c in candidates {
        if Path::new(c).exists() {
            return c.into();
        }
    }
    "node".into()
}

fn copy_dir_all(src: &Path, dest: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let target = dest.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_all(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// Sync the bundled read-only resources into the writable app home.
///
/// Read-only trees (dist, engine, shim-runtime, tools, src) are re-copied on
/// every launch (~40 MB, well under a second) so the home can never go stale
/// after an update. User-writable dirs (out, reports, uploads, folia) are
/// created once and never touched, so outputs, settings, and the user's Folia
/// server jar survive updates.
fn sync_home(resource_home: &Path, app_home: &Path) -> std::io::Result<()> {
    for dir in ["dist", "engine", "shim-runtime", "tools", "src"] {
        let src = resource_home.join(dir);
        if src.exists() {
            copy_dir_all(&src, &app_home.join(dir))?;
        }
    }
    for dir in ["out", "reports", "uploads", "folia"] {
        fs::create_dir_all(app_home.join(dir))?;
    }
    let readme = app_home.join("folia").join("README.txt");
    if !readme.exists() {
        if let Ok(bundled) = fs::read(resource_home.join("folia").join("README.txt")) {
            let _ = fs::write(readme, bundled);
        }
    }
    Ok(())
}

/// node.exe is a console app — without this flag Windows pops a console
/// window next to the GUI for the spawned server.
fn quiet(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Dev: `node <tsx> src/cli.ts gui` in the project tree.
fn spawn_dev_server(root: &Path) -> std::io::Result<Child> {
    let tsx = root.join("node_modules").join("tsx").join("dist").join("cli.mjs");
    quiet(
        Command::new(find_node())
            .arg(tsx)
            .args(["src/cli.ts", "gui", "--no-open", "--port"])
            .arg(PORT.to_string())
            .current_dir(root),
    )
    .spawn()
}

/// Packaged: `node <home>/dist/folia.cjs gui` with FOD_HOME/FOD_BUNDLE set so
/// the server and every job it spawns resolve all paths inside the app home.
fn spawn_packaged_server(app_home: &Path) -> std::io::Result<Child> {
    let bundle = app_home.join("dist").join("folia.cjs");
    quiet(
        Command::new(find_node())
            .arg(&bundle)
            .args(["gui", "--no-open", "--port"])
            .arg(PORT.to_string())
            .current_dir(app_home)
            .env("FOD_HOME", app_home)
            .env("FOD_BUNDLE", &bundle),
    )
    .spawn()
}

fn main() {
    tauri::Builder::default()
        .manage(Server(Mutex::new(None)))
        .setup(move |app| {
            let handle = app.handle().clone();

            // If a server is already on the port, reuse it only when it's the
            // same app version — a leftover from before an update is told to
            // step aside. Otherwise spawn fresh — dev tree first, else the
            // bundled resources copied into a writable per-user home.
            if port_open(PORT) {
                ensure_server_is_current(&app.package_info().version.to_string());
            }
            if !port_open(PORT) {
                let spawned = if let Some(root) = find_project_root() {
                    spawn_dev_server(&root)
                } else {
                    (|| {
                        let resource_home = app
                            .path()
                            .resource_dir()
                            .map(|d| d.join("home"))
                            .map_err(|e| std::io::Error::other(e.to_string()))?;
                        let app_home = app
                            .path()
                            .app_local_data_dir()
                            .map(|d| d.join("home"))
                            .map_err(|e| std::io::Error::other(e.to_string()))?;
                        sync_home(&resource_home, &app_home)?;
                        spawn_packaged_server(&app_home)
                    })()
                };
                match spawned {
                    Ok(child) => *app.state::<Server>().0.lock().unwrap() = Some(child),
                    Err(e) => eprintln!("failed to start GUI server: {e}"),
                }
            }

            // Wait for the server in a background thread, then point the window
            // at it and reveal it. Falls back to the loading page on timeout.
            thread::spawn(move || {
                let deadline = Instant::now() + Duration::from_secs(60);
                while Instant::now() < deadline && !port_open(PORT) {
                    thread::sleep(Duration::from_millis(200));
                }
                if let Some(window) = handle.get_webview_window("main") {
                    if port_open(PORT) {
                        let url = format!("http://127.0.0.1:{PORT}");
                        let _ = window.navigate(url.parse().unwrap());
                    }
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the app")
        .run(|app, event| {
            // Kill the Node server when the app is exiting.
            if let RunEvent::ExitRequested { .. } = event {
                if let Some(mut child) = app.state::<Server>().0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}
