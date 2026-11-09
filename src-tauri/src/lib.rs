mod documents;
mod folders;
#[cfg(windows)]
mod file_drop_bridge;

#[tauri::command]
async fn document_exists(path: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || documents::document_exists(&path)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn rebase_image_paths(from_path: String, to_path: String, sources: Vec<String>) -> Result<Vec<Option<String>>, String> {
    tauri::async_runtime::spawn_blocking(move || documents::rebase_image_paths(&from_path, &to_path, &sources)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn read_document(path: String) -> Result<documents::Document, String> {
    tauri::async_runtime::spawn_blocking(move || documents::read_document(&path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn write_document(
    path: String,
    text: String,
    bom: bool,
    newline: String,
    expected_revision: Option<String>,
) -> Result<documents::WriteResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        documents::write_document(&path, &text, bom, &newline, expected_revision.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn read_local_image(document_path: String, src: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || documents::read_local_image(&document_path, &src))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn import_image(
    document_path: String,
    source_path: Option<String>,
    data_base64: Option<String>,
    file_name: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        documents::import_image(&document_path, source_path.as_deref(), data_base64.as_deref(), file_name.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_document_folder(root: String, path: Option<String>) -> Result<folders::FolderListing, String> {
    tauri::async_runtime::spawn_blocking(move || folders::list_document_folder(&root, path.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
fn initial_path() -> Option<String> {
    std::env::args().skip(1).find(|argument| !argument.starts_with('-')).and_then(|argument| {
        let path = std::path::PathBuf::from(argument);
        let absolute = if path.is_absolute() { path } else { std::env::current_dir().ok()?.join(path) };
        Some(absolute.to_string_lossy().into_owned())
    })
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            #[cfg(windows)] {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    window.with_webview(|webview| unsafe {
                        match webview.controller().CoreWebView2().and_then(|view| file_drop_bridge::attach(&view)) {
                            Ok(()) => {}, Err(error) => eprintln!("无法初始化拖入文件路径服务：{error}"),
                        }
                    })?;
                }
            }
            #[cfg(not(windows))] let _ = app;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![read_document, write_document, read_local_image, import_image, list_document_folder, initial_path, document_exists, rebase_image_paths])
        .run(tauri::generate_context!())
        .expect("Croquill 桌面窗口启动失败");
}
