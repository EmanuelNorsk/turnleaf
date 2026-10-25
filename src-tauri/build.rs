fn main() {
    // Declaring the app's own commands generates allow-* permissions for them,
    // which capabilities/localhost.json grants to the localhost UI.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["update_status", "install_update"])),
    )
    .expect("failed to run tauri-build");
}
