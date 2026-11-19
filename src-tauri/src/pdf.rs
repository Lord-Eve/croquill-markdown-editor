use std::sync::{mpsc, Mutex};
use tauri::{webview::PageLoadEvent, AppHandle, Url, WebviewUrl, WebviewWindowBuilder};
use webview2_com::{CoTaskMemPWSTR, PrintToPdfCompletedHandler, Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Environment6, ICoreWebView2_7, COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT,
}};
use windows_core::Interface;
use crate::documents::PdfExport;

// Called on a blocking worker: all COM calls below run on the WebView's UI thread.
pub fn render(app: AppHandle, path: String, html: String) -> Result<(), String> {
    let job = PdfExport::stage(&path, &html)?;
    let page = Url::from_file_path(&job.page).map_err(|_| "临时页面路径无效")?;
    let allowed = page.clone();
    let output = job.output.to_string_lossy().into_owned();
    let (tx, rx) = mpsc::channel();
    let start = Mutex::new(Some((output, tx)));
    let window = WebviewWindowBuilder::new(&app, "pdf-export", WebviewUrl::External(page.clone()))
        .title("导出 PDF").visible(false).focused(false).skip_taskbar(true)
        .on_navigation(move |url| url == &allowed)
        .on_page_load(move |window, load| {
            if load.event() != PageLoadEvent::Finished || load.url() != &page { return; }
            let Some((output, tx)) = start.lock().unwrap().take() else { return; };
            let schedule_error = tx.clone();
            let result = window.with_webview(move |platform| {
                let done = tx.clone();
                let print = || unsafe {
                    let view: ICoreWebView2_7 = platform.controller().CoreWebView2()?.cast()?;
                    let settings = platform.environment().cast::<ICoreWebView2Environment6>()?.CreatePrintSettings()?;
                    settings.SetOrientation(COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT)?;
                    settings.SetPageWidth(210.0 / 25.4)?;
                    settings.SetPageHeight(297.0 / 25.4)?;
                    settings.SetMarginTop(20.0 / 25.4)?;
                    settings.SetMarginBottom(20.0 / 25.4)?;
                    settings.SetMarginLeft(20.0 / 25.4)?;
                    settings.SetMarginRight(20.0 / 25.4)?;
                    settings.SetShouldPrintHeaderAndFooter(false)?;
                    settings.SetShouldPrintBackgrounds(true)?;
                    let name = CoTaskMemPWSTR::from(output.as_str());
                    view.PrintToPdf(*name.as_ref().as_pcwstr(), &settings,
                        &PrintToPdfCompletedHandler::create(Box::new(move |status, success| {
                            let result = status.map_err(|e| e.to_string()).and_then(|_| {
                                if success { Ok(()) } else { Err("WebView2 打印 PDF 失败".into()) }
                            });
                            let _ = done.send(result);
                            Ok(())
                        })))
                };
                if let Err(error) = print() { let _ = tx.send(Err(error.to_string())); }
            });
            if let Err(error) = result { let _ = schedule_error.send(Err(error.to_string())); }
        })
        .build().map_err(|e| e.to_string())?;
    let result = rx.recv_timeout(std::time::Duration::from_secs(180)).map_err(|e| format!("等待 PDF 打印失败：{e}"));
    let closed = window.destroy().map_err(|e| e.to_string());
    result??;
    closed?;
    job.finish()
}
