//! HTML5 file drops keep text/image dragging intact. WebView2's File object
//! supplies its native path; no browser bytes are mistaken for an opened file.
use webview2_com::{
    Microsoft::Web::WebView2::Win32::{ICoreWebView2, ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs2},
    CoTaskMemPWSTR, WebMessageReceivedEventHandler,
};
use windows_core::{Interface, PWSTR};

fn request_id(message: &str) -> Option<u32> {
    if message.len() > 64 { return None; }
    message.strip_prefix("croquill-file-drop:")?.parse().ok()
}
fn trusted_source(source: &str) -> bool {
    ["http://tauri.localhost/", "https://tauri.localhost/", "tauri://localhost/"].iter().any(|origin| source.starts_with(origin))
        || cfg!(debug_assertions) && source.starts_with("http://127.0.0.1:1420/")
}
fn native_text(read: impl FnOnce(*mut PWSTR) -> windows_core::Result<()>) -> windows_core::Result<String> {
    let mut pointer = PWSTR::null(); let result = read(&mut pointer);
    let text = webview2_com::take_pwstr(pointer); result?; Ok(text)
}

pub fn attach(webview: &ICoreWebView2) -> windows_core::Result<()> {
    let mut token = 0;
    // The handler uses the sender argument rather than capturing a COM view,
    // avoiding a reference cycle for the lifetime of the application window.
    unsafe { webview.add_WebMessageReceived(&WebMessageReceivedEventHandler::create(Box::new(move |sender, args| {
        let (Some(sender), Some(args)) = (sender, args) else { return Ok(()); };
        // Ordinary Tauri IPC has no File objects. Do not copy/parse document
        // payloads while observing this event.
        let Ok(extended) = args.cast::<ICoreWebView2WebMessageReceivedEventArgs2>() else { return Ok(()); };
        let Ok(objects) = extended.AdditionalObjects() else { return Ok(()); };
        let mut count = 0; objects.Count(&mut count)?;
        if count == 0 { return Ok(()); }
        // Wry also subscribes to this event and requires a string message.
        // Keep its handler successful regardless of native subscriber order.
        let message = native_text(|pointer| args.TryGetWebMessageAsString(pointer))?;
        let Some(id) = request_id(&message) else { return Ok(()); };
        let origin = native_text(|pointer| args.Source(pointer))?;
        if !trusted_source(&origin) { return Ok(()); }
        let result = (|| -> Result<String, String> {
            if count != 1 { return Err("请一次只拖入一个 Markdown 文档。".into()); }
            let file = objects.GetValueAtIndex(0).map_err(|e| e.to_string())?.cast::<ICoreWebView2File>().map_err(|_| "拖入对象不是磁盘文件。")?;
            let path = native_text(|pointer| file.Path(pointer)).map_err(|e| e.to_string())?;
            let local = std::path::Path::new(&path);
            if !local.is_absolute() || !local.extension().and_then(|extension| extension.to_str()).is_some_and(|extension| ["md", "markdown", "mdown", "mkd"].iter().any(|kind| extension.eq_ignore_ascii_case(kind))) {
                return Err("拖入文件不是本地 Markdown 文档。".into());
            }
            Ok(path)
        })();
        let reply = match result { Ok(path) => format!("croquill-file-drop:{id}:ok\n{path}"), Err(error) => format!("croquill-file-drop:{id}:error\n{error}") };
        let message = CoTaskMemPWSTR::from(reply.as_str());
        sender.PostWebMessageAsString(*message.as_ref().as_pcwstr())?;
        Ok(())
    })), &mut token) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_namespaced_small_requests_are_accepted() {
        assert_eq!(request_id("croquill-file-drop:42"), Some(42));
        assert_eq!(request_id("{\"cmd\":\"write_document\"}"), None);
        assert_eq!(request_id("croquill-file-drop:-1"), None);
        assert!(!trusted_source("https://example.com/"));
        assert!(!trusted_source("http://tauri.localhost.evil/"));
        assert!(trusted_source("http://tauri.localhost/index.html"));
    }
}
