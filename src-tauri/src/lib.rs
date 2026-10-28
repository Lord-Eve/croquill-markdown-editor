mod documents;

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
        .invoke_handler(tauri::generate_handler![read_document, write_document, read_local_image, initial_path])
        .run(tauri::generate_context!())
        .expect("Croquill 桌面窗口启动失败");
}
