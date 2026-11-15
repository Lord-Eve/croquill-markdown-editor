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
pub fn validate_external_link_url(url: &str) -> Result<(), String> {
    if url.is_empty() {
        return Err("链接地址为空".to_string());
    }
    if url.len() > 2048 {
        return Err("链接地址过长".to_string());
    }
    if url.chars().any(|c| c.is_whitespace() || c.is_ascii_control() || c == '"') {
        return Err("链接地址包含非法空白、引号或控制字符".to_string());
    }
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:")) {
        return Err("暂不支持打开此类链接".to_string());
    }
    Ok(())
}

#[cfg(windows)]
fn open_with_shell(url: &str) -> Result<(), String> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::{S_FALSE, S_OK};
    use windows_sys::Win32::System::Com::{
        CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
    };
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    struct ComGuard(bool);
    impl Drop for ComGuard {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize(); }
            }
        }
    }

    let hr = unsafe { CoInitializeEx(null(), (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32) };
    let _guard = ComGuard(hr == S_OK || hr == S_FALSE);
    let verb: Vec<u16> = "open\0".encode_utf16().collect();
    let target: Vec<u16> = url.encode_utf16().chain(std::iter::once(0)).collect();
    let result = unsafe {
        ShellExecuteW(null_mut(), verb.as_ptr(), target.as_ptr(), null(), null(), SW_SHOWNORMAL)
    } as isize;
    if result <= 32 {
        return Err(format!("无法打开外部链接（系统错误码：{result}）"));
    }
    Ok(())
}

#[cfg(not(windows))]
fn open_with_shell(_url: &str) -> Result<(), String> {
    Err("当前平台暂不支持打开外部链接".to_string())
}

#[tauri::command]
async fn open_external_link(url: String) -> Result<(), String> {
    validate_external_link_url(&url)?;
    tauri::async_runtime::spawn_blocking(move || open_with_shell(&url))
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
        .invoke_handler(tauri::generate_handler![read_document, write_document, read_local_image, import_image, list_document_folder, initial_path, document_exists, rebase_image_paths, open_external_link])
        .run(tauri::generate_context!())
        .expect("Croquill 桌面窗口启动失败");
}

#[cfg(test)]
mod tests {
    use super::validate_external_link_url;

    #[test]
    fn accepts_http_https_and_mailto_urls() {
        assert!(validate_external_link_url("https://example.com/a?b=c").is_ok());
        assert!(validate_external_link_url("HTTP://X.COM").is_ok());
        assert!(validate_external_link_url("mailto:a@b.com").is_ok());
    }

    #[test]
    fn rejects_disallowed_schemes_paths_whitespace_and_oversized_urls() {
        for bad in [
            "file:///C:/x",
            "javascript:alert(1)",
            r"C:\Windows\system32\calc.exe",
            r"\\server\share",
            "https://example.com/a b",
            "https://example.com/a\nb",
            "https://example.com/a\rb",
            "https://example.com/a\tb",
            r#"https://example.com/?a="b""#,
            "",
        ] {
            assert!(validate_external_link_url(bad).is_err(), "expected rejection for {bad:?}");
        }
        let oversized = format!("https://example.com/{}", "a".repeat(2040));
        assert!(oversized.len() > 2048);
        assert!(validate_external_link_url(&oversized).is_err());
    }
}
